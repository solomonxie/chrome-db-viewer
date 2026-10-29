#include "log.hpp"

#include <unistd.h>

#include <chrono>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <mutex>

namespace dbui::log {
namespace {

std::mutex g_mutex;
std::ofstream g_file;

std::string defaultPath() {
  if (const char* env = std::getenv("DBUI_RUNNER_LOG"); env && *env) return env;
  const char* home = std::getenv("HOME");
  return std::string(home ? home : "/tmp") + "/Library/Logs/dbui/runner.log";
}

void write(const char* level, std::string_view msg) {
  std::lock_guard lock(g_mutex);
  if (!g_file.is_open()) return;
  auto now = std::chrono::system_clock::now();
  std::time_t t = std::chrono::system_clock::to_time_t(now);
  std::tm tm{};
  localtime_r(&t, &tm);
  char stamp[32];
  std::strftime(stamp, sizeof stamp, "%Y-%m-%d %H:%M:%S", &tm);
  g_file << stamp << " [" << getpid() << "] " << level << " " << msg << '\n';
  g_file.flush();
}

}  // namespace

void init(const std::string& path) {
  std::string p = path.empty() ? defaultPath() : path;
  std::error_code ec;
  std::filesystem::create_directories(std::filesystem::path(p).parent_path(), ec);
  std::lock_guard lock(g_mutex);
  g_file.open(p, std::ios::app);
}

void info(std::string_view msg) { write("INFO", msg); }
void warn(std::string_view msg) { write("WARN", msg); }
void error(std::string_view msg) { write("ERROR", msg); }

}  // namespace dbui::log
