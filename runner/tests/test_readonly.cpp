#include <catch2/catch_test_macros.hpp>

#include "drivers/postgres.hpp"
#include "drivers/redis.hpp"

using namespace dbui;

TEST_CASE("redis tokenizer handles quotes and escapes") {
  auto argv = redis::tokenize(R"(HSET "session:1" name 'O\'Brien' note "a\tb\x41")");
  REQUIRE(argv == std::vector<std::string>{"HSET", "session:1", "name", "O'Brien", "note", "a\tbA"});
  REQUIRE(redis::tokenize("   ").empty());
  REQUIRE_THROWS(redis::tokenize(R"(GET "open)"));
}

TEST_CASE("redis write commands are refused by name, case-insensitively") {
  for (const char* line : {"SET k v", "set k v", "DEL k", "HSET h f v", "FLUSHALL", "EXPIRE k 10", "ZADD z 1 m",
                           "EVAL 'return 1' 0", "MULTI", "CONFIG SET maxmemory 1", "SCRIPT FLUSH", "XADD s * f v",
                           "RENAME a b", "SELECT 1", "FUNCTION DELETE lib", "CLIENT KILL ID 1"}) {
    INFO(line);
    REQUIRE(redis::isWriteCommand(redis::tokenize(line)));
  }
}

TEST_CASE("redis read commands are allowed") {
  for (const char* line : {"GET k", "HGETALL session:1", "SCAN 0 MATCH * COUNT 10", "TYPE k", "TTL k",
                           "ZRANGE z 0 -1 WITHSCORES", "LRANGE l 0 -1", "SMEMBERS s", "INFO", "CONFIG GET maxmemory",
                           "XRANGE s - +", "EXISTS k", "DBSIZE", "CLIENT LIST", "SORT_RO l"}) {
    INFO(line);
    REQUIRE_FALSE(redis::isWriteCommand(redis::tokenize(line)));
  }
}

TEST_CASE("postgres refuses statements that turn read-only off") {
  REQUIRE(pg::overridesReadOnly("SET default_transaction_read_only = off"));
  REQUIRE(pg::overridesReadOnly("set transaction_read_only to false"));
  REQUIRE(pg::overridesReadOnly("BEGIN READ WRITE"));
  REQUIRE(pg::overridesReadOnly("start transaction read  write"));
  REQUIRE(pg::overridesReadOnly("SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE"));
  REQUIRE(pg::overridesReadOnly("reset ROLE; set role postgres"));
  REQUIRE_FALSE(pg::overridesReadOnly("select * from orders where note = 'read'"));
  REQUIRE_FALSE(pg::overridesReadOnly("BEGIN READ ONLY"));
}

TEST_CASE("postgres type mapping") {
  REQUIRE(pg::cellFromText(20, "9007199254740993", 16) == "9007199254740993");  // int8 → string
  REQUIRE(pg::cellFromText(1700, "12.50", 5) == "12.50");                       // numeric → string
  REQUIRE(pg::cellFromText(23, "42", 2) == 42);
  REQUIRE(pg::cellFromText(701, "1.5", 3) == 1.5);
  REQUIRE(pg::cellFromText(701, "NaN", 3) == "NaN");
  REQUIRE(pg::cellFromText(16, "t", 1) == true);
  REQUIRE(pg::cellFromText(3802, R"({"a":[1,2]})", 11) == json::parse(R"({"a":[1,2]})"));
  REQUIRE(pg::cellFromText(1184, "2024-01-01 00:00:00+00", 22) == "2024-01-01 00:00:00+00");
}
