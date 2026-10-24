cmake_minimum_required(VERSION 3.16)

set(VERSION_FILE "${CMAKE_CURRENT_LIST_DIR}/VERSION")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${VERSION_FILE}")
if(NOT EXISTS "${VERSION_FILE}")
    message(FATAL_ERROR "Missing VERSION file")
endif()
file(STRINGS "${VERSION_FILE}" WATTPOST_VERSION LIMIT_COUNT 1)
string(STRIP "${WATTPOST_VERSION}" WATTPOST_VERSION)
if(NOT WATTPOST_VERSION MATCHES "^V[0-9]+[.][0-9]+([.][0-9]+)?$")
    message(FATAL_ERROR "Invalid VERSION value: ${WATTPOST_VERSION}")
endif()
set(PROJECT_VER "${WATTPOST_VERSION}")
set(WATTPOST_WEB_VERSION "${WATTPOST_VERSION}")

get_filename_component(WATTPOST_REPO_DIR "${CMAKE_CURRENT_LIST_DIR}/.." REALPATH)

execute_process(
    COMMAND git -c "safe.directory=${WATTPOST_REPO_DIR}" -C "${WATTPOST_REPO_DIR}" rev-parse --short=12 HEAD
    OUTPUT_VARIABLE WATTPOST_GIT_SHA
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
)
if(NOT WATTPOST_GIT_SHA)
    set(WATTPOST_GIT_SHA "unknown")
endif()
execute_process(
    COMMAND git -c "safe.directory=${WATTPOST_REPO_DIR}" -C "${WATTPOST_REPO_DIR}" status --porcelain --untracked-files=normal -- esp32_monitor
    OUTPUT_VARIABLE WATTPOST_GIT_STATUS
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
)
set(WATTPOST_BUILD_ID "${WATTPOST_GIT_SHA}")
if(WATTPOST_GIT_STATUS)
    string(APPEND WATTPOST_BUILD_ID "-dirty")
endif()

file(WRITE "${CMAKE_BINARY_DIR}/wattpost_build.h"
    "#pragma once\n"
    "#define WATTPOST_FIRMWARE_VERSION \"${WATTPOST_VERSION}\"\n"
    "#define WATTPOST_WEB_VERSION \"${WATTPOST_WEB_VERSION}\"\n"
    "#define WATTPOST_BUILD_ID \"${WATTPOST_BUILD_ID}\"\n"
)

message(STATUS "WattPost version: ${WATTPOST_VERSION} (${WATTPOST_BUILD_ID})")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(wattpost_mini)
