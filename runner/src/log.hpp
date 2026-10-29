// Runner logging. Logs go to a file only (default ~/Library/Logs/dbui/runner.log),
// never to stdout, which carries protocol frames and nothing else.
#pragma once

#include <string>
#include <string_view>

namespace dbui::log {

/** Opens the log file. `path` empty means $DBUI_RUNNER_LOG or ~/Library/Logs/dbui/runner.log. */
void init(const std::string& path = "");
void info(std::string_view msg);
void warn(std::string_view msg);
void error(std::string_view msg);

}  // namespace dbui::log
