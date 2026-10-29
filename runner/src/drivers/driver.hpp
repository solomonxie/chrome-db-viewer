// Driver interface for the runner. One runner process serves one connection tab, so a
// driver instance owns exactly one database connection. See design/DESIGN.md §3.4.
#pragma once

#include <nlohmann/json.hpp>

#include <atomic>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>

namespace dbui {

using json = nlohmann::json;

/** Set from the stdin reader thread when the extension sends `cancel` for the running job. */
struct CancelToken {
  std::atomic<bool> cancelled{false};
  bool isCancelled() const { return cancelled.load(std::memory_order_relaxed); }
};

/** An error reported to the extension as {"type":"error","code":…,"message":…}. */
struct DriverError : std::runtime_error {
  std::string code;
  DriverError(std::string code_, const std::string& message) : std::runtime_error(message), code(std::move(code_)) {}
};

/** Receives a result set row by row. The Pager implements it and splits rows into messages. */
class PageSink {
 public:
  virtual ~PageSink() = default;
  /** Column list (array of Column objects), sent once before the first row. */
  virtual void columns(const json& cols) = 0;
  /** One row: a JSON array of Cells. */
  virtual void row(json&& row) = 0;
};

struct ExecResult {
  std::optional<long long> affectedRows;
  std::string message;
};

struct ConnectOptions {
  json conn;             // RunnerConnectConfig as sent by the extension
  std::string password;  // read from Keychain via secretRef, empty if none
  bool readOnly = false;
  bool metadata = false;  // second, read-only connection for tree/describe
};

class Driver {
 public:
  virtual ~Driver() = default;
  /** Opens the connection. Returns extra fields for the `ok` reply, e.g. {"server": "PostgreSQL 17.2"}. */
  virtual json connect(const ConnectOptions& opts) = 0;
  virtual void disconnect() = 0;
  /** Returns an array of ObjectNode. */
  virtual json listObjects(const json& parent, CancelToken& token) = 0;
  /** Returns a TableSchema. */
  virtual json describe(const json& path, CancelToken& token) = 0;
  /** Streams the result of `req` ({sql, params?, pageSize?}) into `sink`. */
  virtual ExecResult execute(const json& req, PageSink& sink, CancelToken& token) = 0;
  /** Runs `statements` ([{sql, params?}]) in one transaction. Returns extra `ok` fields, e.g. {"applied": 3}. */
  virtual json apply(const json& statements, CancelToken& token) = 0;
  /** Interrupts the running call. Called from another thread; must be thread safe. */
  virtual void cancel() = 0;
};

std::unique_ptr<Driver> makePostgresDriver();
std::unique_ptr<Driver> makeRedisDriver();

/** Converts a Cell to the text form used for query parameters / command arguments. nullopt for null. */
inline std::optional<std::string> cellToText(const json& v) {
  if (v.is_null()) return std::nullopt;
  if (v.is_string()) return v.get<std::string>();
  if (v.is_boolean()) return v.get<bool>() ? "true" : "false";
  return v.dump();
}

}  // namespace dbui
