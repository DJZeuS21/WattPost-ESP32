/*
 * Captive DNS behavior follows the ESP-IDF captive portal example concept.
 * Protocol parsing is WattPost-specific and bounded in captive_dns_protocol.c.
 */
#include "captive_dns.h"

#include <errno.h>
#include <string.h>

#include "captive_dns_protocol.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"

#define CAPTIVE_DNS_PORT 53
#define CAPTIVE_DNS_PACKET_MAX 512

static const char *TAG = "wattpost-dns";

typedef struct {
    bool active;
    int socket_fd;
    TaskHandle_t task;
    uint8_t ap_ipv4[4];
} captive_dns_state_t;

static portMUX_TYPE dns_lock = portMUX_INITIALIZER_UNLOCKED;
static captive_dns_state_t dns_state = {
    .socket_fd = -1,
};

static bool captive_dns_active_snapshot(void) {
    bool active;
    portENTER_CRITICAL(&dns_lock);
    active = dns_state.active;
    portEXIT_CRITICAL(&dns_lock);
    return active;
}

static void captive_dns_mark_task_stopped(int socket_fd) {
    portENTER_CRITICAL(&dns_lock);
    if (dns_state.socket_fd == socket_fd) {
        dns_state.socket_fd = -1;
    }
    dns_state.active = false;
    dns_state.task = NULL;
    portEXIT_CRITICAL(&dns_lock);
}

static void captive_dns_task(void *unused) {
    (void) unused;

    const int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock < 0) {
        ESP_LOGE(TAG, "DNS socket create failed: errno=%d", errno);
        captive_dns_mark_task_stopped(-1);
        vTaskDelete(NULL);
        return;
    }

    portENTER_CRITICAL(&dns_lock);
    if (!dns_state.active) {
        portEXIT_CRITICAL(&dns_lock);
        close(sock);
        captive_dns_mark_task_stopped(sock);
        vTaskDelete(NULL);
        return;
    }
    dns_state.socket_fd = sock;
    portEXIT_CRITICAL(&dns_lock);

    const int reuse = 1;
    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));

    const struct timeval timeout = {
        .tv_sec = 1,
        .tv_usec = 0,
    };
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));

    struct sockaddr_in bind_addr = {
        .sin_family = AF_INET,
        .sin_port = htons(CAPTIVE_DNS_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    if (bind(
            sock,
            (const struct sockaddr *) &bind_addr,
            sizeof(bind_addr)) != 0) {
        ESP_LOGE(TAG, "DNS bind failed: errno=%d", errno);
        close(sock);
        captive_dns_mark_task_stopped(sock);
        vTaskDelete(NULL);
        return;
    }

    ESP_LOGI(TAG, "Captive DNS active on UDP/53");

    uint8_t request[CAPTIVE_DNS_PACKET_MAX];
    uint8_t response[CAPTIVE_DNS_PACKET_MAX];

    while (captive_dns_active_snapshot()) {
        struct sockaddr_storage source;
        socklen_t source_len = sizeof(source);
        const int received = recvfrom(
            sock,
            request,
            sizeof(request),
            0,
            (struct sockaddr *) &source,
            &source_len);

        if (received < 0) {
            if (!captive_dns_active_snapshot()) {
                break;
            }
            if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) {
                continue;
            }
            ESP_LOGW(TAG, "DNS recv failed: errno=%d", errno);
            continue;
        }
        if (received == 0) {
            continue;
        }

        uint8_t ap_ipv4[4];
        portENTER_CRITICAL(&dns_lock);
        memcpy(ap_ipv4, dns_state.ap_ipv4, sizeof(ap_ipv4));
        portEXIT_CRITICAL(&dns_lock);

        const int response_len = wattpost_captive_dns_build_response(
            request,
            (size_t) received,
            response,
            sizeof(response),
            ap_ipv4);
        if (response_len <= 0) {
            continue;
        }

        const int sent = sendto(
            sock,
            response,
            (size_t) response_len,
            0,
            (const struct sockaddr *) &source,
            source_len);
        if (sent < 0 && captive_dns_active_snapshot()) {
            ESP_LOGW(TAG, "DNS send failed: errno=%d", errno);
        }
    }

    shutdown(sock, SHUT_RDWR);
    close(sock);
    captive_dns_mark_task_stopped(sock);
    ESP_LOGI(TAG, "Captive DNS stopped");
    vTaskDelete(NULL);
}

bool wattpost_captive_dns_start(esp_netif_t *ap_netif) {
    if (!ap_netif) {
        return false;
    }

    portENTER_CRITICAL(&dns_lock);
    const bool already_active = dns_state.active;
    const bool task_present = dns_state.task != NULL;
    portEXIT_CRITICAL(&dns_lock);
    if (already_active) {
        return true;
    }
    if (task_present) {
        return false;
    }

    esp_netif_ip_info_t ip_info = {0};
    if (esp_netif_get_ip_info(ap_netif, &ip_info) != ESP_OK ||
        ip_info.ip.addr == 0u) {
        return false;
    }

    const uint32_t host_ip = ntohl(ip_info.ip.addr);
    uint8_t ap_ipv4[4] = {
        (uint8_t) (host_ip >> 24u),
        (uint8_t) (host_ip >> 16u),
        (uint8_t) (host_ip >> 8u),
        (uint8_t) host_ip,
    };

    portENTER_CRITICAL(&dns_lock);
    dns_state.active = true;
    dns_state.socket_fd = -1;
    memcpy(dns_state.ap_ipv4, ap_ipv4, sizeof(ap_ipv4));
    portEXIT_CRITICAL(&dns_lock);

    TaskHandle_t task = NULL;
    if (xTaskCreate(
            captive_dns_task,
            "captive_dns",
            3072,
            NULL,
            4,
            &task) != pdPASS) {
        portENTER_CRITICAL(&dns_lock);
        dns_state.active = false;
        dns_state.task = NULL;
        memset(dns_state.ap_ipv4, 0, sizeof(dns_state.ap_ipv4));
        portEXIT_CRITICAL(&dns_lock);
        return false;
    }

    portENTER_CRITICAL(&dns_lock);
    /*
     * The task cannot be restarted until it clears this handle on exit.
     * If it failed immediately, keep NULL rather than storing a stale handle.
     */
    if (dns_state.active) {
        dns_state.task = task;
    }
    portEXIT_CRITICAL(&dns_lock);
    return captive_dns_active_snapshot();
}

void wattpost_captive_dns_stop(void) {
    int sock;

    portENTER_CRITICAL(&dns_lock);
    dns_state.active = false;
    sock = dns_state.socket_fd;
    portEXIT_CRITICAL(&dns_lock);

    if (sock >= 0) {
        shutdown(sock, SHUT_RDWR);
    }
}

bool wattpost_captive_dns_is_active(void) {
    return captive_dns_active_snapshot();
}
