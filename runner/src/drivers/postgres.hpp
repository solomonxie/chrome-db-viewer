// PostgreSQL driver on libpq. Streams results with PQsendQuery[Params] + PQsetSingleRowMode,
// cancels with PQcancel from another thread, and enforces read-only mode with
// default_transaction_read_only.
#pragma once

#include <string_view>

#include "driver.hpp"

namespace dbui::pg {

/**
 * True when `sql` tries to turn read-only mode back off (SET default_transaction_read_only,
 * SET transaction_read_only, BEGIN/START TRANSACTION READ WRITE …). A read-only connection
 * refuses these before they reach the server.
 */
bool overridesReadOnly(std::string_view sql);

/** Converts one text-format value to a Cell according to its type OID. */
json cellFromText(unsigned int oid, const char* text, int len);

}  // namespace dbui::pg
