cmake_minimum_required(VERSION 3.24)

# Release builds use vcpkg manifest mode (vcpkg.json) with static deps and
# -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64". Local builds find Homebrew packages: the
# Homebrew prefixes below are added to CMAKE_PREFIX_PATH automatically when brew exists.
project(dbui-runner VERSION 0.1.0 LANGUAGES C CXX OBJCXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OBJCXX_STANDARD 20)
set(CMAKE_OBJCXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(DBUI_BUILD_TESTS "Build Catch2 unit tests" ON)

if(NOT DEFINED VCPKG_TOOLCHAIN AND NOT CMAKE_TOOLCHAIN_FILE)
  find_program(BREW_EXECUTABLE brew)
  if(BREW_EXECUTABLE)
    foreach(pkg libpq hiredis nlohmann-json catch2 openssl@3)
      execute_process(COMMAND ${BREW_EXECUTABLE} --prefix ${pkg}
                      OUTPUT_VARIABLE _prefix OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
      if(_prefix AND EXISTS "${_prefix}")
        list(APPEND CMAKE_PREFIX_PATH "${_prefix}")
      endif()
    endforeach()
  endif()
endif()

find_package(nlohmann_json 3.11 REQUIRED)
find_package(PostgreSQL REQUIRED)  # FindPostgreSQL: libpq

# hiredis: vcpkg ships a CMake config; Homebrew doesn't, so fall back to a plain search.
find_package(hiredis CONFIG QUIET)
if(TARGET hiredis::hiredis)
  set(HIREDIS_TARGET hiredis::hiredis)
else()
  find_path(HIREDIS_INCLUDE_DIR hiredis/hiredis.h REQUIRED)
  find_library(HIREDIS_LIBRARY NAMES hiredis REQUIRED)
  add_library(hiredis_imported UNKNOWN IMPORTED)
  set_target_properties(hiredis_imported PROPERTIES IMPORTED_LOCATION "${HIREDIS_LIBRARY}"
                        INTERFACE_INCLUDE_DIRECTORIES "${HIREDIS_INCLUDE_DIR}")
  set(HIREDIS_TARGET hiredis_imported)
endif()

# Everything except main.cpp goes into a library so the tests can link it.
add_library(dbui_core STATIC
  src/backup.cpp
  src/framing.cpp
  src/log.cpp
  src/pager.cpp
  src/session.cpp
  src/drivers/postgres.cpp
  src/drivers/redis.cpp
  src/secret_store_keychain.mm
)
target_include_directories(dbui_core PUBLIC src)
target_compile_definitions(dbui_core PUBLIC DBUI_RUNNER_VERSION="${PROJECT_VERSION}")
target_compile_options(dbui_core PRIVATE -Wall -Wextra)
target_link_libraries(dbui_core PUBLIC nlohmann_json::nlohmann_json PostgreSQL::PostgreSQL ${HIREDIS_TARGET}
                      "-framework Security" "-framework CoreFoundation")
set_source_files_properties(src/secret_store_keychain.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")

add_executable(dbui-runner src/main.cpp)
target_compile_options(dbui-runner PRIVATE -Wall -Wextra)
target_link_libraries(dbui-runner PRIVATE dbui_core)

if(DBUI_BUILD_TESTS)
  find_package(Catch2 3 REQUIRED)
  enable_testing()
  add_executable(dbui-runner-tests
    tests/test_backup.cpp
    tests/test_framing.cpp
    tests/test_pager.cpp
    tests/test_readonly.cpp
  )
  target_link_libraries(dbui-runner-tests PRIVATE dbui_core Catch2::Catch2WithMain)
  include(Catch)
  catch_discover_tests(dbui-runner-tests)
endif()

install(TARGETS dbui-runner RUNTIME DESTINATION .)
