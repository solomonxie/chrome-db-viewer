// backup.write / backup.read file handling, against a temporary HOME so the real
// ~/Library/Application Support/dbui/backup.json is never touched.
#include <catch2/catch_test_macros.hpp>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

#include "backup.hpp"
#include "drivers/driver.hpp"

using namespace dbui;
namespace fs = std::filesystem;

namespace {

/** Points HOME at a fresh temp dir for one test and restores it afterwards. */
struct TempHome {
  fs::path dir;
  std::string oldHome;
  TempHome() {
    const char* h = std::getenv("HOME");
    oldHome = h ? h : "";
    std::string tmpl = (fs::temp_directory_path() / "dbui-backup-test-XXXXXX").string();
    REQUIRE(mkdtemp(tmpl.data()) != nullptr);
    dir = tmpl;
    setenv("HOME", dir.c_str(), 1);
  }
  ~TempHome() {
    setenv("HOME", oldHome.c_str(), 1);
    std::error_code ec;
    fs::remove_all(dir, ec);
  }
};

std::string slurp(const fs::path& p) {
  std::ifstream in(p, std::ios::binary);
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

std::string backupJson(int n) {
  return R"({"format":"dbui-backup","version":1,"exportedAt":)" + std::to_string(n) + R"(,"stores":{},"settings":{}})";
}

}  // namespace

TEST_CASE("defaultDir is under HOME/Library/Application Support/dbui") {
  TempHome home;
  REQUIRE(backup::defaultDir() == home.dir / "Library" / "Application Support" / "dbui");
}

TEST_CASE("read with no backup returns nullopt and exists=false") {
  TempHome home;
  backup::Info info;
  REQUIRE_FALSE(backup::read(backup::defaultDir(), &info).has_value());
  REQUIRE_FALSE(info.exists);
  REQUIRE(info.mtimeMs == 0);
}

TEST_CASE("write creates the folder, writes atomically and leaves no temp file") {
  TempHome home;
  fs::path dir = backup::defaultDir();
  backup::Info info = backup::write(dir, backupJson(1));
  REQUIRE(info.exists);
  REQUIRE(info.mtimeMs > 0);
  REQUIRE(info.size == backupJson(1).size());
  REQUIRE(slurp(dir / "backup.json") == backupJson(1));
  REQUIRE_FALSE(fs::exists(dir / "backup.prev.json"));

  int files = 0;
  for (auto& e : fs::directory_iterator(dir)) {
    REQUIRE(e.path().filename().string().find(".tmp") == std::string::npos);
    ++files;
  }
  REQUIRE(files == 1);

  struct stat st {};
  REQUIRE(::stat((dir / "backup.json").c_str(), &st) == 0);
  REQUIRE((st.st_mode & 0777) == 0600);
  REQUIRE(::stat(dir.c_str(), &st) == 0);
  REQUIRE((st.st_mode & 0777) == 0700);

  backup::Info readInfo;
  auto got = backup::read(dir, &readInfo);
  REQUIRE(got == backupJson(1));
  REQUIRE(readInfo.mtimeMs == info.mtimeMs);
}

TEST_CASE("a second write keeps the previous copy as backup.prev.json") {
  TempHome home;
  fs::path dir = backup::defaultDir();
  backup::write(dir, backupJson(1));
  backup::write(dir, backupJson(2));
  REQUIRE(slurp(dir / "backup.json") == backupJson(2));
  REQUIRE(slurp(dir / "backup.prev.json") == backupJson(1));
  backup::write(dir, backupJson(3));
  REQUIRE(slurp(dir / "backup.json") == backupJson(3));
  REQUIRE(slurp(dir / "backup.prev.json") == backupJson(2));
}

TEST_CASE("writes over 50 MB are refused and leave the current backup alone") {
  TempHome home;
  fs::path dir = backup::defaultDir();
  backup::write(dir, backupJson(1));
  std::string big = R"({"format":"dbui-backup","pad":")" + std::string(backup::kMaxBackupBytes, 'x') + "\"}";
  try {
    backup::write(dir, big);
    FAIL("expected BACKUP_TOO_LARGE");
  } catch (const DriverError& e) {
    REQUIRE(e.code == "BACKUP_TOO_LARGE");
  }
  REQUIRE(slurp(dir / "backup.json") == backupJson(1));
  REQUIRE_FALSE(fs::exists(dir / "backup.prev.json"));
}

TEST_CASE("an oversized file on disk is refused on read") {
  TempHome home;
  fs::path dir = backup::defaultDir();
  fs::create_directories(dir);
  {
    std::ofstream out(dir / "backup.json", std::ios::binary);
    out.seekp(static_cast<std::streamoff>(backup::kMaxBackupBytes));
    out.put('}');
  }
  try {
    backup::read(dir);
    FAIL("expected BACKUP_TOO_LARGE");
  } catch (const DriverError& e) {
    REQUIRE(e.code == "BACKUP_TOO_LARGE");
  }
}

TEST_CASE("anything that isn't a dbui backup object is refused") {
  TempHome home;
  fs::path dir = backup::defaultDir();
  for (std::string bad : {std::string("not json"), std::string("[1,2]"), std::string(R"({"format":"other"})")}) {
    try {
      backup::write(dir, bad);
      FAIL("expected BACKUP_INVALID for " + bad);
    } catch (const DriverError& e) {
      REQUIRE(e.code == "BACKUP_INVALID");
    }
  }
  REQUIRE_FALSE(fs::exists(dir / "backup.json"));
}

TEST_CASE("chunkUtf8 never splits a multi-byte character and reassembles exactly") {
  std::string s;
  for (int i = 0; i < 1000; ++i) s += "aé€😀";  // 1 + 2 + 3 + 4 bytes
  auto pieces = backup::chunkUtf8(s, 7);
  std::string joined;
  for (auto p : pieces) {
    REQUIRE(p.size() <= 7);
    REQUIRE((static_cast<unsigned char>(p.front()) & 0xC0) != 0x80);
    joined += p;
  }
  REQUIRE(joined == s);
  REQUIRE(backup::chunkUtf8("", 10).empty());
}
