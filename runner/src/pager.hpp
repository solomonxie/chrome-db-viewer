// Splits a result set into `page` messages that stay under Chrome's 1 MB limit for
// runner → Chrome messages, and at most `pageSize` rows each.
#pragma once

#include <cstddef>
#include <functional>
#include <string>

#include "drivers/driver.hpp"

namespace dbui {

class Pager : public PageSink {
 public:
  using Emit = std::function<void(std::string)>;
  /** Room left for framing slack and the JSON envelope; messages are kept below this size. */
  static constexpr std::size_t kDefaultMaxBytes = 1024 * 1024 - 8 * 1024;
  static constexpr std::size_t kDefaultPageSize = 2000;

  Pager(long long id, std::size_t pageSize, Emit emit, std::size_t maxBytes = kDefaultMaxBytes);

  void columns(const json& cols) override;
  void row(json&& row) override;
  /** Sends any buffered rows as a final page. */
  void flush();

  long long rowCount() const { return total_; }
  int pagesSent() const { return seq_; }

 private:
  std::string prefix() const;
  std::string fitRow(json& row) const;

  long long id_;
  std::size_t pageSize_;
  Emit emit_;
  std::size_t maxBytes_;
  std::string buf_;
  std::size_t rowsInBuf_ = 0;
  int seq_ = 0;
  long long total_ = 0;
};

/** Serializes JSON for the wire, replacing invalid UTF-8 instead of throwing. */
std::string dumpJson(const json& j);

}  // namespace dbui
