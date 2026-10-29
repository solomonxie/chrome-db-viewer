// Redis driver on hiredis. `execute` takes a command line such as `HGETALL session:1`,
// `listObjects` walks keys with SCAN (never KEYS), and read-only connections refuse
// write commands by name.
#pragma once

#include <string>
#include <string_view>
#include <vector>

#include "driver.hpp"

namespace dbui::redis {

/** Splits a command line into arguments. Supports "double" (with \n \t \" \\ \xHH escapes) and 'single' quotes. */
std::vector<std::string> tokenize(std::string_view line);

/**
 * True when `argv` would change data or server state. Used to enforce read-only mode.
 * Matches on the command name (and the subcommand for CONFIG, SCRIPT, FUNCTION, …).
 */
bool isWriteCommand(const std::vector<std::string>& argv);

}  // namespace dbui::redis
