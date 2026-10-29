#include "pager.hpp"

#include <algorithm>

namespace dbui {
namespace {

/** Cuts `s` to at most `n` bytes without splitting a UTF-8 sequence. */
std::string utf8Prefix(const std::string& s, std::size_t n) {
  if (s.size() <= n) return s;
  while (n > 0 && (static_cast<unsigned char>(s[n]) & 0xC0) == 0x80) --n;
  return s.substr(0, n);
}

}  // namespace

std::string dumpJson(const json& j) { return j.dump(-1, ' ', false, json::error_handler_t::replace); }

Pager::Pager(long long id, std::size_t pageSize, Emit emit, std::size_t maxBytes)
    : id_(id), pageSize_(pageSize == 0 ? kDefaultPageSize : pageSize), emit_(std::move(emit)), maxBytes_(maxBytes) {}

void Pager::columns(const json& cols) {
  emit_(dumpJson(json{{"id", id_}, {"type", "columns"}, {"cols", cols}}));
}

std::string Pager::prefix() const {
  return R"({"id":)" + std::to_string(id_) + R"(,"type":"page","seq":)" + std::to_string(seq_) + R"(,"rows":[)";
}

// A single row bigger than a whole message can't be split across pages, so its largest
// cells are cut down (and marked) until it fits.
std::string Pager::fitRow(json& row) const {
  std::string s = dumpJson(row);
  const std::size_t room = maxBytes_ - prefix().size() - 2;
  if (s.size() <= room) return s;
  const std::size_t n = std::max<std::size_t>(row.size(), 1);
  const std::size_t perCell = room / n > 64 ? room / n - 64 : 16;
  for (auto& cell : row) {
    std::string text = cell.is_string() ? cell.get<std::string>() : dumpJson(cell);
    if (text.size() > perCell) cell = utf8Prefix(text, perCell) + "…[truncated]";
  }
  return dumpJson(row);
}

void Pager::row(json&& r) {
  std::string s = fitRow(r);
  const std::size_t overhead = prefix().size() + 2;
  if (rowsInBuf_ > 0 && buf_.size() + 1 + s.size() + overhead > maxBytes_) flush();
  if (rowsInBuf_ > 0) buf_ += ',';
  buf_ += s;
  ++rowsInBuf_;
  ++total_;
  if (rowsInBuf_ >= pageSize_) flush();
}

void Pager::flush() {
  if (rowsInBuf_ == 0) return;
  std::string msg = prefix();
  msg += buf_;
  msg += "]}";
  buf_.clear();
  rowsInBuf_ = 0;
  ++seq_;
  emit_(std::move(msg));
}

}  // namespace dbui
