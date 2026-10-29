#include "framing.hpp"

#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <stdexcept>

namespace dbui::framing {
namespace {

bool readExact(int fd, char* out, std::size_t n) {
  std::size_t got = 0;
  while (got < n) {
    ssize_t r = ::read(fd, out + got, n - got);
    if (r == 0) return false;
    if (r < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    got += static_cast<std::size_t>(r);
  }
  return true;
}

void checkLength(std::uint32_t len) {
  if (len > kMaxInboundFrame) throw std::runtime_error("frame too large: " + std::to_string(len));
}

}  // namespace

std::string encode(std::string_view payload) {
  std::uint32_t len = static_cast<std::uint32_t>(payload.size());
  std::string out(sizeof len + payload.size(), '\0');
  std::memcpy(out.data(), &len, sizeof len);
  std::memcpy(out.data() + sizeof len, payload.data(), payload.size());
  return out;
}

std::optional<std::string> decode(std::string& buffer) {
  std::uint32_t len = 0;
  if (buffer.size() < sizeof len) return std::nullopt;
  std::memcpy(&len, buffer.data(), sizeof len);
  checkLength(len);
  if (buffer.size() < sizeof len + len) return std::nullopt;
  std::string payload = buffer.substr(sizeof len, len);
  buffer.erase(0, sizeof len + len);
  return payload;
}

std::optional<std::string> readFrame(int fd) {
  std::uint32_t len = 0;
  if (!readExact(fd, reinterpret_cast<char*>(&len), sizeof len)) return std::nullopt;
  checkLength(len);
  std::string payload(len, '\0');
  if (len > 0 && !readExact(fd, payload.data(), len)) return std::nullopt;
  return payload;
}

bool writeFrame(int fd, std::string_view payload) {
  std::string frame = encode(payload);
  std::size_t sent = 0;
  while (sent < frame.size()) {
    ssize_t w = ::write(fd, frame.data() + sent, frame.size() - sent);
    if (w < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    sent += static_cast<std::size_t>(w);
  }
  return true;
}

}  // namespace dbui::framing
