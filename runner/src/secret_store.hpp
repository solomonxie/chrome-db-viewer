// Secrets (passwords, SSH keys) live in the macOS login Keychain as generic password items
// with service "dev.dbui.runner" and account = the extension's secretRef. See DESIGN.md §3.7.
#pragma once

#include <optional>
#include <string>

namespace dbui::secrets {

inline constexpr const char* kService = "dev.dbui.runner";

/** Creates or replaces the item. Throws DriverError on failure. */
void set(const std::string& ref, const std::string& value);
/** nullopt when there is no such item. Throws DriverError on other failures. */
std::optional<std::string> get(const std::string& ref);
/** Returns false when there was no such item. Throws DriverError on other failures. */
bool remove(const std::string& ref);

}  // namespace dbui::secrets
