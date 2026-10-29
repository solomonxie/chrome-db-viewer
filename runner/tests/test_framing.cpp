#include <catch2/catch_test_macros.hpp>
#include <unistd.h>

#include <cstring>
#include <stdexcept>
#include <string>

#include "framing.hpp"

using namespace dbui;

TEST_CASE("encode writes a native-endian 4-byte length") {
  std::string frame = framing::encode(R"({"id":1})");
  REQUIRE(frame.size() == 4 + 8);
  std::uint32_t len = 0;
  std::memcpy(&len, frame.data(), 4);
  REQUIRE(len == 8);
  REQUIRE(frame.substr(4) == R"({"id":1})");
}

TEST_CASE("decode round trips several frames and waits for partial ones") {
  std::string a = R"({"id":1,"op":"hello"})";
  std::string b = R"({"id":2,"op":"execute","sql":"select 'é'"})";
  std::string buf = framing::encode(a) + framing::encode(b);
  std::string tail = buf.substr(buf.size() - 3);
  buf.resize(buf.size() - 3);

  REQUIRE(framing::decode(buf) == a);
  REQUIRE_FALSE(framing::decode(buf).has_value());
  buf += tail;
  REQUIRE(framing::decode(buf) == b);
  REQUIRE(buf.empty());
}

TEST_CASE("empty payload is a valid frame") {
  std::string buf = framing::encode("");
  REQUIRE(framing::decode(buf) == std::string());
}

TEST_CASE("oversized declared length is rejected") {
  std::uint32_t len = framing::kMaxInboundFrame + 1;
  std::string buf(4, '\0');
  std::memcpy(buf.data(), &len, 4);
  REQUIRE_THROWS_AS(framing::decode(buf), std::runtime_error);
}

TEST_CASE("readFrame/writeFrame round trip over a pipe, EOF ends cleanly") {
  int fds[2];
  REQUIRE(pipe(fds) == 0);
  REQUIRE(framing::writeFrame(fds[1], R"({"id":7,"type":"ok"})"));
  REQUIRE(framing::writeFrame(fds[1], R"({"id":8,"type":"done"})"));
  close(fds[1]);
  REQUIRE(framing::readFrame(fds[0]) == std::string(R"({"id":7,"type":"ok"})"));
  REQUIRE(framing::readFrame(fds[0]) == std::string(R"({"id":8,"type":"done"})"));
  REQUIRE_FALSE(framing::readFrame(fds[0]).has_value());
  close(fds[0]);
}
