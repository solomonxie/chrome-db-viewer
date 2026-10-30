#include "backup.hpp"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>

#include "drivers/driver.hpp"

namespace dbui::backup {
namespace fs = std::filesystem;

namespace {

constexpr const char* kFile = "backup.json";
constexpr const char* kPrev = "backup.prev.json";

[[noreturn]] void ioError(const std::string& what) {
  throw DriverError("BACKUP_IO", what + ": " + std::strerror(errno));
}

std::string tooLarge(std::size_t size) {
  return "Backup is " + std::to_string(size / (1024 * 1024)) + " MB; the limit is " +
         std::to_string(kMaxBackupBytes / (1024 * 1024)) + " MB";
}

long long mtimeMs(const struct stat& st) {
  return static_cast<long long>(st.st_mtimespec.tv_sec) * 1000 + st.st_mtimespec.tv_nsec / 1000000;
}

void writeAll(int fd, std::string_view data) {
  while (!data.empty()) {
    ssize_t n = ::write(fd, data.data(), data.size());
    if (n < 0) {
      if (errno == EINTR) continue;
      ioError("writing the backup");
    }
    data.remove_prefix(static_cast<std::size_t>(n));
  }
}

}  // namespace

fs::path defaultDir() {
  const char* home = std::getenv("HOME");
  if (!home || !*home) throw DriverError("BACKUP_NO_HOME", "HOME is not set");
  return fs::path(home) / "Library" / "Application Support" / "dbui";
}

Info stat(const fs::path& dir) {
  struct stat st {};
  if (::stat((dir / kFile).c_str(), &st) != 0) return {};
  return Info{true, mtimeMs(st), static_cast<std::size_t>(st.st_size)};
}

Info write(const fs::path& dir, std::string_view data) {
  if (data.size() > kMaxBackupBytes) throw DriverError("BACKUP_TOO_LARGE", tooLarge(data.size()));
  json j = json::parse(data, nullptr, false);
  if (!j.is_object() || j.value("format", "") != "dbui-backup") {
    throw DriverError("BACKUP_INVALID", "Not a dbui backup (expected a JSON object with \"format\": \"dbui-backup\")");
  }

  std::error_code ec;
  fs::create_directories(dir, ec);
  if (ec) throw DriverError("BACKUP_IO", "Can't create " + dir.string() + ": " + ec.message());
  ::chmod(dir.c_str(), 0700);

  const fs::path target = dir / kFile;
  const fs::path prev = dir / kPrev;
  const fs::path tmp = dir / ("backup.json.tmp-" + std::to_string(::getpid()));

  int fd = ::open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd < 0) ioError("creating " + tmp.string());
  try {
    writeAll(fd, data);
    if (::fsync(fd) != 0) ioError("flushing the backup");
  } catch (...) {
    ::close(fd);
    ::unlink(tmp.c_str());
    throw;
  }
  if (::close(fd) != 0) {
    ::unlink(tmp.c_str());
    ioError("closing the backup");
  }

  // Keep the current file as backup.prev.json. A hard link leaves backup.json in place, so
  // there is never a moment without one; the rename below then swaps in the new file.
  if (fs::exists(target)) {
    ::unlink(prev.c_str());
    if (::link(target.c_str(), prev.c_str()) != 0) {
      fs::copy_file(target, prev, fs::copy_options::overwrite_existing, ec);
    }
  }
  if (::rename(tmp.c_str(), target.c_str()) != 0) {
    int saved = errno;
    ::unlink(tmp.c_str());
    errno = saved;
    ioError("replacing " + target.string());
  }
  return stat(dir);
}

std::optional<std::string> read(const fs::path& dir, Info* info) {
  Info st = stat(dir);
  if (info) *info = st;
  if (!st.exists) return std::nullopt;
  if (st.size > kMaxBackupBytes) throw DriverError("BACKUP_TOO_LARGE", tooLarge(st.size));
  std::ifstream in(dir / kFile, std::ios::binary);
  if (!in) ioError("opening the backup");
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

std::vector<std::string_view> chunkUtf8(std::string_view s, std::size_t maxBytes) {
  std::vector<std::string_view> out;
  if (maxBytes < 4) maxBytes = 4;
  while (!s.empty()) {
    std::size_t n = std::min(maxBytes, s.size());
    // Back off over continuation bytes (10xxxxxx) so the cut lands on a sequence start.
    if (n < s.size()) {
      while (n > 0 && (static_cast<unsigned char>(s[n]) & 0xC0) == 0x80) --n;
      if (n == 0) n = std::min(maxBytes, s.size());
    }
    out.push_back(s.substr(0, n));
    s.remove_prefix(n);
  }
  return out;
}

}  // namespace dbui::backup
