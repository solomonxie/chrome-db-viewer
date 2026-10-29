#include "postgres.hpp"

#include <libpq-fe.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <mutex>
#include <optional>
#include <regex>
#include <unordered_map>
#include <vector>

#include "../log.hpp"

namespace dbui {
namespace pg {

namespace {

// Built-in type OIDs (src/include/catalog/pg_type.dat).
constexpr unsigned kBool = 16, kInt8 = 20, kInt2 = 21, kInt4 = 23, kOid = 26, kJson = 114, kFloat4 = 700,
                   kFloat8 = 701, kNumeric = 1700, kJsonb = 3802;

}  // namespace

bool overridesReadOnly(std::string_view sql) {
  static const std::regex pattern(
      R"((default_)?transaction_read_only|read\s+write|set\s+session\s+characteristics|set\s+(session\s+|local\s+)?role|session_authorization)",
      std::regex::icase);
  return std::regex_search(std::string(sql), pattern);
}

json cellFromText(unsigned oid, const char* text, int len) {
  std::string_view v(text, static_cast<std::size_t>(len));
  switch (oid) {
    case kBool:
      return v == "t";
    case kInt2:
    case kInt4:
    case kOid:
      return std::strtoll(text, nullptr, 10);
    case kFloat4:
    case kFloat8: {
      double d = std::strtod(text, nullptr);
      if (std::isfinite(d)) return d;
      return std::string(v);  // NaN, Infinity stay strings: JSON has no number for them
    }
    case kJson:
    case kJsonb: {
      json parsed = json::parse(v.begin(), v.end(), nullptr, false);
      if (parsed.is_discarded()) return std::string(v);
      return parsed;
    }
    case kInt8:
    case kNumeric:
    default:
      return std::string(v);  // int8, numeric, timestamps, uuid … keep full precision as text
  }
}

}  // namespace pg

namespace {

using Row = std::vector<std::optional<std::string>>;

struct ResultHolder {
  PGresult* r;
  explicit ResultHolder(PGresult* r_) : r(r_) {}
  ~ResultHolder() {
    if (r) PQclear(r);
  }
  ResultHolder(const ResultHolder&) = delete;
  ResultHolder& operator=(const ResultHolder&) = delete;
};

std::string trimmed(const char* s) {
  std::string out(s ? s : "");
  while (!out.empty() && std::isspace(static_cast<unsigned char>(out.back()))) out.pop_back();
  return out;
}

DriverError errorFrom(const PGresult* r, PGconn* conn, bool cancelled) {
  const char* state = r ? PQresultErrorField(r, PG_DIAG_SQLSTATE) : nullptr;
  std::string code = state ? state : "PG";
  std::string msg;
  if (r) {
    const char* primary = PQresultErrorField(r, PG_DIAG_MESSAGE_PRIMARY);
    if (primary) {
      msg = primary;
      if (const char* detail = PQresultErrorField(r, PG_DIAG_MESSAGE_DETAIL)) msg += std::string("\nDETAIL: ") + detail;
      if (const char* hint = PQresultErrorField(r, PG_DIAG_MESSAGE_HINT)) msg += std::string("\nHINT: ") + hint;
      if (const char* pos = PQresultErrorField(r, PG_DIAG_STATEMENT_POSITION)) msg += std::string("\nPOSITION: ") + pos;
    } else {
      msg = trimmed(PQresultErrorMessage(r));
    }
  }
  if (msg.empty()) msg = trimmed(PQerrorMessage(conn));
  if (code == "57014" && cancelled) code = "CANCELLED";
  return DriverError(code, msg.empty() ? "query failed" : msg);
}

std::string optString(const json& j, const char* key) {
  auto it = j.find(key);
  if (it == j.end() || it->is_null()) return "";
  if (it->is_string()) return it->get<std::string>();
  return it->dump();
}

class PostgresDriver : public Driver {
 public:
  ~PostgresDriver() override { disconnect(); }

  json connect(const ConnectOptions& opts) override {
    disconnect();
    readOnly_ = opts.readOnly || opts.metadata;
    const json& c = opts.conn;

    std::vector<std::pair<std::string, std::string>> kv;
    auto add = [&](const char* k, std::string v) {
      if (!v.empty()) kv.emplace_back(k, std::move(v));
    };
    add("host", optString(c, "host"));
    add("port", optString(c, "port"));
    add("user", optString(c, "user"));
    std::string db = optString(c, "database");
    if (db.empty()) db = optString(c, "db");
    add("dbname", db);
    add("password", opts.password);
    add("sslmode", optString(c, "sslmode"));
    add("application_name", opts.metadata ? "dbui (metadata)" : "dbui");
    add("connect_timeout", "10");
    if (readOnly_) add("options", "-c default_transaction_read_only=on");

    std::vector<const char*> keys, values;
    for (auto& [k, v] : kv) {
      keys.push_back(k.c_str());
      values.push_back(v.c_str());
    }
    keys.push_back(nullptr);
    values.push_back(nullptr);

    PGconn* conn = PQconnectdbParams(keys.data(), values.data(), 0);
    if (!conn || PQstatus(conn) != CONNECTION_OK) {
      std::string msg = conn ? trimmed(PQerrorMessage(conn)) : "out of memory";
      if (conn) PQfinish(conn);
      throw DriverError("CONNECT_FAILED", msg);
    }
    PQsetNoticeProcessor(conn, [](void*, const char* m) { log::info(std::string("pg notice: ") + trimmed(m)); }, nullptr);
    {
      std::lock_guard lock(cancelMu_);
      conn_ = conn;
      cancel_ = PQgetCancel(conn);
    }
    if (readOnly_) exec("SET default_transaction_read_only = on");
    loadTypeNames();

    std::string version = PQparameterStatus(conn, "server_version") ? PQparameterStatus(conn, "server_version") : "";
    log::info("pg connected, server " + version + (readOnly_ ? " (read-only)" : ""));
    return json{{"server", "PostgreSQL " + version}};
  }

  void disconnect() override {
    std::lock_guard lock(cancelMu_);
    if (cancel_) PQfreeCancel(cancel_);
    cancel_ = nullptr;
    if (conn_) PQfinish(conn_);
    conn_ = nullptr;
  }

  void cancel() override {
    std::lock_guard lock(cancelMu_);
    if (!cancel_) return;
    char err[256] = {0};
    if (!PQcancel(cancel_, err, sizeof err)) log::warn(std::string("PQcancel failed: ") + err);
  }

  // ---- tree ----------------------------------------------------------------------------

  json listObjects(const json& parentJ, CancelToken&) override {
    auto parent = parentJ.get<std::vector<std::string>>();
    json nodes = json::array();
    if (parent.empty()) {
      auto rows = query(R"(
        select n.nspname,
               (select count(*) from pg_class c where c.relnamespace = n.oid and c.relkind in ('r','p','v','m'))
        from pg_namespace n
        where n.nspname not like 'pg\_toast%' and n.nspname not like 'pg\_temp\_%'
        order by (n.nspname in ('pg_catalog','information_schema')), n.nspname)");
      for (auto& r : rows) {
        nodes.push_back({{"path", {*r[0]}}, {"name", *r[0]}, {"type", "schema"}, {"hasChildren", true}, {"meta", *r[1]}});
      }
      return nodes;
    }
    const std::string& schema = parent[0];
    if (parent.size() == 1) {
      static const std::pair<const char*, const char*> groups[] = {
          {"tables", "tables"}, {"views", "views"}, {"matviews", "materialized views"}, {"functions", "functions"}};
      for (auto& [id, label] : groups) {
        nodes.push_back({{"path", {schema, id}}, {"name", label}, {"type", "group"}, {"hasChildren", true}});
      }
      return nodes;
    }
    const std::string& group = parent[1];
    if (group == "functions") {
      auto rows = query(R"(
        select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', p.proname,
               coalesce(pg_get_function_result(p.oid), '')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1 and p.prokind in ('f','p')
        order by 1)",
                        {schema});
      for (auto& r : rows) {
        nodes.push_back({{"path", {schema, group, *r[0]}}, {"name", *r[0]}, {"type", "function"}, {"hasChildren", false},
                         {"meta", *r[2]}});
      }
      return nodes;
    }
    std::string kinds, type;
    if (group == "tables") kinds = "'r','p','f'", type = "table";
    else if (group == "views") kinds = "'v'", type = "view";
    else if (group == "matviews") kinds = "'m'", type = "materialized_view";
    else throw DriverError("NOT_FOUND", "unknown group: " + group);
    auto rows = query(
        "select c.relname, case when c.relkind in ('r','p','m') and c.reltuples >= 0 "
        "then '~' || c.reltuples::bigint::text else '' end "
        "from pg_class c join pg_namespace n on n.oid = c.relnamespace "
        "where n.nspname = $1 and c.relkind in (" + kinds + ") order by c.relname",
        {schema});
    for (auto& r : rows) {
      json node{{"path", {schema, group, *r[0]}}, {"name", *r[0]}, {"type", type}, {"hasChildren", false}};
      if (!r[1]->empty()) node["meta"] = *r[1];
      nodes.push_back(node);
    }
    return nodes;
  }

  json describe(const json& pathJ, CancelToken&) override {
    auto path = pathJ.get<std::vector<std::string>>();
    if (path.size() < 2) throw DriverError("BAD_REQUEST", "describe needs [schema, (group,) name]");
    const std::string& schema = path.front();
    const std::string& name = path.back();
    const std::string group = path.size() >= 3 ? path[1] : "";

    if (group == "functions") return describeFunction(pathJ, schema, name);

    auto rel = query(R"(
      select c.oid::text, c.relkind::text, coalesce(obj_description(c.oid, 'pg_class'), ''),
             pg_size_pretty(pg_total_relation_size(c.oid)), greatest(c.reltuples, 0)::bigint::text
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2)",
                     {schema, name});
    if (rel.empty()) throw DriverError("NOT_FOUND", "relation " + schema + "." + name + " does not exist");
    const std::string oid = *rel[0][0];
    const std::string kind = *rel[0][1];

    auto cols = query(R"(
      select a.attname, format_type(a.atttypid, a.atttypmod), (not a.attnotnull)::text,
             pg_get_expr(d.adbin, d.adrelid),
             exists(select 1 from pg_index i where i.indrelid = a.attrelid and i.indisprimary
                    and a.attnum = any(i.indkey))::text,
             (select case when fn.nspname = $2 then '' else fn.nspname || '.' end || fc.relname || '.' || fa.attname
              from pg_constraint k
              join pg_class fc on fc.oid = k.confrelid
              join pg_namespace fn on fn.oid = fc.relnamespace
              join pg_attribute fa on fa.attrelid = k.confrelid
                   and fa.attnum = k.confkey[array_position(k.conkey, a.attnum)]
              where k.conrelid = a.attrelid and k.contype = 'f' and a.attnum = any(k.conkey)
              limit 1),
             (select string_agg(e.enumlabel, E'\x1f' order by e.enumsortorder)
              from pg_enum e where e.enumtypid = a.atttypid)
      from pg_attribute a
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = $1::oid and a.attnum > 0 and not a.attisdropped
      order by a.attnum)",
                      {oid, schema});
    json columns = json::array();
    for (auto& r : cols) {
      json col{{"name", *r[0]}, {"type", *r[1]}, {"nullable", *r[2] == "true"}};
      if (*r[4] == "true") col["primaryKey"] = true;
      col["default"] = r[3] ? json(*r[3]) : json(nullptr);
      if (r[5]) col["references"] = *r[5];
      if (r[6]) {
        json values = json::array();
        std::string s = *r[6];
        std::size_t start = 0;
        for (;;) {
          auto pos = s.find('\x1f', start);
          values.push_back(s.substr(start, pos - start));
          if (pos == std::string::npos) break;
          start = pos + 1;
        }
        col["enumValues"] = values;
      }
      columns.push_back(col);
    }

    auto idx = query(R"(
      select ic.relname, i.indisunique::text, i.indisprimary::text, pg_get_indexdef(i.indexrelid),
             coalesce((select string_agg(coalesce(a.attname, '<expr>'), E'\x1f' order by k.ord)
                       from unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
                       left join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                       where k.ord <= i.indnkeyatts), '')
      from pg_index i join pg_class ic on ic.oid = i.indexrelid
      where i.indrelid = $1::oid
      order by i.indisprimary desc, ic.relname)",
                     {oid});
    json indexes = json::array();
    std::vector<std::string> indexDefs;
    for (auto& r : idx) {
      json colsJ = json::array();
      std::string s = *r[4];
      std::size_t start = 0;
      while (!s.empty()) {
        auto pos = s.find('\x1f', start);
        colsJ.push_back(s.substr(start, pos - start));
        if (pos == std::string::npos) break;
        start = pos + 1;
      }
      indexes.push_back({{"name", *r[0]}, {"columns", colsJ}, {"unique", *r[1] == "true"}, {"primary", *r[2] == "true"},
                         {"definition", *r[3]}});
      if (*r[2] != "true") indexDefs.push_back(*r[3]);
    }

    json schemaJ{{"path", pathJ}, {"columns", columns}, {"indexes", indexes}};
    json info{{"kind", kindName(kind)}, {"size", *rel[0][3]}, {"estimated rows", *rel[0][4]}};
    if (!rel[0][2]->empty()) info["comment"] = *rel[0][2];
    schemaJ["info"] = info;
    schemaJ["ddl"] = buildDdl(kind, oid, schema, name, columns, indexDefs);
    return schemaJ;
  }

  // ---- execute -------------------------------------------------------------------------

  ExecResult execute(const json& req, PageSink& sink, CancelToken& token) override {
    PGconn* conn = requireConn();
    const std::string sql = req.value("sql", "");
    if (readOnly_ && pg::overridesReadOnly(sql)) {
      throw DriverError("READ_ONLY", "This connection is read-only; changing the read-only setting is not allowed");
    }

    std::vector<std::optional<std::string>> params;
    if (auto it = req.find("params"); it != req.end() && it->is_array()) {
      for (auto& p : *it) params.push_back(cellToText(p));
    }

    int sent;
    if (params.empty()) {
      sent = PQsendQuery(conn, sql.c_str());  // allows several statements; each result set streams
    } else {
      std::vector<const char*> values;
      for (auto& p : params) values.push_back(p ? p->c_str() : nullptr);
      sent = PQsendQueryParams(conn, sql.c_str(), static_cast<int>(values.size()), nullptr, values.data(), nullptr,
                               nullptr, 0);
    }
    if (!sent) throw DriverError("PG", trimmed(PQerrorMessage(conn)));
    if (!PQsetSingleRowMode(conn)) log::warn("PQsetSingleRowMode failed");

    ExecResult result;
    std::optional<DriverError> failure;
    bool haveColumns = false;
    std::vector<unsigned> oids;
    // Keep reading until PQgetResult returns null, even after an error or a cancel, so the
    // connection is ready for the next query.
    for (;;) {
      ResultHolder r(PQgetResult(conn));
      if (!r.r) break;
      ExecStatusType st = PQresultStatus(r.r);
      if (st == PGRES_SINGLE_TUPLE || st == PGRES_TUPLES_OK) {
        if (failure) continue;
        if (!haveColumns) {
          sendColumns(r.r, sink, oids);
          haveColumns = true;
        }
        if (st == PGRES_TUPLES_OK) {
          haveColumns = false;  // end of this result set; the next one (if any) gets its own columns
          continue;
        }
        if (token.isCancelled()) continue;  // PQcancel is on its way; drop the rest
        const int n = PQnfields(r.r);
        json row = json::array();
        for (int i = 0; i < n; ++i) {
          if (PQgetisnull(r.r, 0, i)) row.push_back(nullptr);
          else row.push_back(pg::cellFromText(oids[i], PQgetvalue(r.r, 0, i), PQgetlength(r.r, 0, i)));
        }
        sink.row(std::move(row));
      } else if (st == PGRES_COMMAND_OK) {
        const char* n = PQcmdTuples(r.r);
        if (n && *n) result.affectedRows = result.affectedRows.value_or(0) + std::atoll(n);
        result.message = PQcmdStatus(r.r);
      } else if (st == PGRES_EMPTY_QUERY) {
        // nothing
      } else {
        if (!failure) failure = errorFrom(r.r, conn, token.isCancelled());
      }
    }
    if (failure) throw *failure;
    if (token.isCancelled()) throw DriverError("CANCELLED", "Query cancelled");
    return result;
  }

  json apply(const json& statements, CancelToken& token) override {
    PGconn* conn = requireConn();
    if (readOnly_) throw DriverError("READ_ONLY", "This connection is read-only");
    if (!statements.is_array()) throw DriverError("BAD_REQUEST", "statements must be an array");
    exec("BEGIN");
    int applied = 0;
    try {
      for (auto& s : statements) {
        if (token.isCancelled()) throw DriverError("CANCELLED", "Apply cancelled");
        std::vector<std::optional<std::string>> params;
        if (auto it = s.find("params"); it != s.end() && it->is_array()) {
          for (auto& p : *it) params.push_back(cellToText(p));
        }
        std::vector<const char*> values;
        for (auto& p : params) values.push_back(p ? p->c_str() : nullptr);
        const std::string sql = s.value("sql", "");
        ResultHolder r(PQexecParams(conn, sql.c_str(), static_cast<int>(values.size()), nullptr, values.data(), nullptr,
                                    nullptr, 0));
        ExecStatusType st = PQresultStatus(r.r);
        if (st != PGRES_COMMAND_OK && st != PGRES_TUPLES_OK) {
          DriverError e = errorFrom(r.r, conn, token.isCancelled());
          throw DriverError(e.code, "statement " + std::to_string(applied + 1) + ": " + e.what());
        }
        ++applied;
      }
      exec("COMMIT");
    } catch (...) {
      ResultHolder r(PQexec(conn, "ROLLBACK"));
      throw;
    }
    return json{{"applied", applied}};
  }

 private:
  PGconn* requireConn() {
    if (!conn_) throw DriverError("NOT_CONNECTED", "Not connected");
    return conn_;
  }

  void exec(const char* sql) {
    ResultHolder r(PQexec(requireConn(), sql));
    ExecStatusType st = PQresultStatus(r.r);
    if (st != PGRES_COMMAND_OK && st != PGRES_TUPLES_OK) throw errorFrom(r.r, conn_, false);
  }

  std::vector<Row> query(const std::string& sql, const std::vector<std::string>& params = {}) {
    std::vector<const char*> values;
    for (auto& p : params) values.push_back(p.c_str());
    ResultHolder r(PQexecParams(requireConn(), sql.c_str(), static_cast<int>(values.size()), nullptr, values.data(),
                                nullptr, nullptr, 0));
    if (PQresultStatus(r.r) != PGRES_TUPLES_OK) throw errorFrom(r.r, conn_, false);
    std::vector<Row> rows;
    const int nr = PQntuples(r.r), nf = PQnfields(r.r);
    rows.reserve(static_cast<std::size_t>(nr));
    for (int i = 0; i < nr; ++i) {
      Row row;
      for (int j = 0; j < nf; ++j) {
        if (PQgetisnull(r.r, i, j)) row.emplace_back(std::nullopt);
        else row.emplace_back(std::string(PQgetvalue(r.r, i, j), static_cast<std::size_t>(PQgetlength(r.r, i, j))));
      }
      rows.push_back(std::move(row));
    }
    return rows;
  }

  void loadTypeNames() {
    typeNames_.clear();
    for (auto& r : query("select oid::text, typname from pg_type")) {
      typeNames_[static_cast<unsigned>(std::stoul(*r[0]))] = *r[1];
    }
  }

  void sendColumns(const PGresult* r, PageSink& sink, std::vector<unsigned>& oids) {
    json cols = json::array();
    oids.clear();
    const int n = PQnfields(r);
    for (int i = 0; i < n; ++i) {
      unsigned oid = PQftype(r, i);
      oids.push_back(oid);
      auto it = typeNames_.find(oid);
      cols.push_back({{"name", PQfname(r, i)},
                      {"type", it != typeNames_.end() ? it->second : "oid:" + std::to_string(oid)},
                      {"nullable", true}});
    }
    sink.columns(cols);
  }

  static std::string kindName(const std::string& k) {
    if (k == "r") return "table";
    if (k == "p") return "partitioned table";
    if (k == "v") return "view";
    if (k == "m") return "materialized view";
    if (k == "f") return "foreign table";
    return k;
  }

  static std::string ident(const std::string& s) {
    std::string out = "\"";
    for (char c : s) {
      if (c == '"') out += '"';
      out += c;
    }
    return out + "\"";
  }

  std::string buildDdl(const std::string& kind, const std::string& oid, const std::string& schema,
                       const std::string& name, const json& columns, const std::vector<std::string>& indexDefs) {
    const std::string qname = ident(schema) + "." + ident(name);
    if (kind == "v" || kind == "m") {
      auto def = query("select pg_get_viewdef($1::oid, true)", {oid});
      std::string body = def.empty() || !def[0][0] ? "" : *def[0][0];
      std::string ddl = std::string(kind == "v" ? "CREATE VIEW " : "CREATE MATERIALIZED VIEW ") + qname + " AS\n" + body;
      for (auto& d : indexDefs) ddl += "\n" + d + ";";
      return ddl;
    }
    std::string ddl = "CREATE TABLE " + qname + " (\n";
    std::vector<std::string> lines;
    for (auto& c : columns) {
      std::string line = "  " + ident(c["name"].get<std::string>()) + " " + c["type"].get<std::string>();
      if (!c["default"].is_null()) line += " DEFAULT " + c["default"].get<std::string>();
      if (!c["nullable"].get<bool>()) line += " NOT NULL";
      lines.push_back(line);
    }
    for (auto& r : query("select conname, pg_get_constraintdef(oid, true) from pg_constraint "
                         "where conrelid = $1::oid and contype in ('p','u','f','c','x') order by contype, conname",
                         {oid})) {
      lines.push_back("  CONSTRAINT " + ident(*r[0]) + " " + *r[1]);
    }
    for (std::size_t i = 0; i < lines.size(); ++i) ddl += lines[i] + (i + 1 < lines.size() ? ",\n" : "\n");
    ddl += ");";
    for (auto& d : indexDefs) ddl += "\n" + d + ";";
    return ddl;
  }

  json describeFunction(const json& pathJ, const std::string& schema, const std::string& signature) {
    auto rows = query(R"(
      select pg_get_functiondef(p.oid), coalesce(pg_get_function_result(p.oid), ''), l.lanname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
      where n.nspname = $1 and p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = $2)",
                      {schema, signature});
    if (rows.empty()) throw DriverError("NOT_FOUND", "function " + signature + " does not exist");
    return json{{"path", pathJ},
                {"columns", json::array()},
                {"indexes", json::array()},
                {"ddl", *rows[0][0]},
                {"info", {{"kind", "function"}, {"returns", *rows[0][1]}, {"language", *rows[0][2]}}}};
  }

  std::mutex cancelMu_;
  PGconn* conn_ = nullptr;
  PGcancel* cancel_ = nullptr;
  bool readOnly_ = false;
  std::unordered_map<unsigned, std::string> typeNames_;
};

}  // namespace

std::unique_ptr<Driver> makePostgresDriver() { return std::make_unique<PostgresDriver>(); }

}  // namespace dbui
