// Automatic backup of the extension's saved data (design/DESIGN.md §3.16). Chrome deletes an
// extension's IndexedDB and chrome.storage when it is uninstalled, so the extension sends a
// JSON export here (`backup.write`) and reads it back on a fresh install (`backup.read`).
//
// Files, in ~/Library/Application Support/dbui/:
//   backup.json       the latest export, replaced atomically (temp file + rename)
//   backup.prev.json  the copy it replaced
// The JSON never holds secrets: the extension strips them before sending.
#pragma once

#include <cstddef>
#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace dbui::backup {

/** Largest backup the runner writes or reads back. */
inline constexpr std::size_t kMaxBackupBytes = 50u * 1024u * 1024u;

/** $HOME/Library/Application Support/dbui. Throws DriverError("BACKUP_NO_HOME") without HOME. */
std::filesystem::path defaultDir();

struct Info {
  bool exists = false;
  /** Modification time in milliseconds since the epoch; 0 when missing. */
  long long mtimeMs = 0;
  std::size_t size = 0;
};

/**
 * Validates `json` (a JSON object with "format": "dbui-backup", at most kMaxBackupBytes) and
 * writes it to dir/backup.json atomically, keeping the previous file as backup.prev.json.
 * Creates `dir` (mode 0700) if needed. Throws DriverError: BACKUP_TOO_LARGE, BACKUP_INVALID,
 * BACKUP_IO.
 */
Info write(const std::filesystem::path& dir, std::string_view json);

/** Size and mtime of dir/backup.json. */
Info stat(const std::filesystem::path& dir);

/** Contents of dir/backup.json, or nullopt when there is none. Throws BACKUP_TOO_LARGE / BACKUP_IO. */
std::optional<std::string> read(const std::filesystem::path& dir, Info* info = nullptr);

/**
 * Splits `s` into pieces of at most `maxBytes` bytes without cutting a UTF-8 sequence, so each
 * piece is valid UTF-8 on its own (runner → Chrome messages must stay under 1 MB).
 */
std::vector<std::string_view> chunkUtf8(std::string_view s, std::size_t maxBytes);

}  // namespace dbui::backup
