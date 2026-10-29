#include <catch2/catch_test_macros.hpp>

#include <string>
#include <vector>

#include "framing.hpp"
#include "pager.hpp"

using namespace dbui;

namespace {

std::vector<json> run(std::size_t pageSize, int rows, std::size_t cellBytes, std::size_t maxBytes = Pager::kDefaultMaxBytes) {
  std::vector<std::string> raw;
  Pager pager(42, pageSize, [&](std::string m) { raw.push_back(std::move(m)); }, maxBytes);
  pager.columns(json::array({{{"name", "id"}, {"type", "int4"}, {"nullable", false}},
                             {{"name", "body"}, {"type", "text"}, {"nullable", true}}}));
  for (int i = 0; i < rows; ++i) pager.row(json::array({i, std::string(cellBytes, 'x')}));
  pager.flush();
  std::vector<json> out;
  for (auto& m : raw) {
    REQUIRE(m.size() < framing::kMaxOutboundFrame);
    out.push_back(json::parse(m));
  }
  return out;
}

}  // namespace

TEST_CASE("pages honour pageSize") {
  auto msgs = run(100, 250, 10);
  REQUIRE(msgs.size() == 1 + 3);
  REQUIRE(msgs[0]["type"] == "columns");
  REQUIRE(msgs[1]["rows"].size() == 100);
  REQUIRE(msgs[3]["rows"].size() == 50);
  REQUIRE(msgs[3]["seq"] == 2);
}

TEST_CASE("wide rows split pages to stay under 1 MB") {
  // 2000 rows × ~10 KB = ~20 MB in total: must become 20+ messages, each < 1 MB.
  auto msgs = run(2000, 2000, 10 * 1024);
  REQUIRE(msgs.size() > 20);
  std::size_t total = 0;
  int seq = 0;
  for (std::size_t i = 1; i < msgs.size(); ++i) {
    REQUIRE(msgs[i]["type"] == "page");
    REQUIRE(msgs[i]["id"] == 42);
    REQUIRE(msgs[i]["seq"] == seq++);
    total += msgs[i]["rows"].size();
  }
  REQUIRE(total == 2000);
  REQUIRE(msgs.back()["rows"].back()[0] == 1999);
}

TEST_CASE("a single row larger than 1 MB is truncated to fit") {
  auto msgs = run(2000, 3, 3 * 1024 * 1024);
  std::size_t total = 0;
  for (std::size_t i = 1; i < msgs.size(); ++i) total += msgs[i]["rows"].size();
  REQUIRE(total == 3);
  std::string cell = msgs[1]["rows"][0][1];
  REQUIRE(cell.size() < 1024 * 1024);
  REQUIRE(cell.find("[truncated]") != std::string::npos);
}

TEST_CASE("no rows sends no page") {
  auto msgs = run(2000, 0, 0);
  REQUIRE(msgs.size() == 1);
}
