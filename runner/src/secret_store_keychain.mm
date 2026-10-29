// Keychain-backed SecretStore (Security.framework). Generic password items, service
// dev.dbui.runner, account = secretRef. Items stay on this Mac (not iCloud-synced).
#include "secret_store.hpp"

#import <CoreFoundation/CoreFoundation.h>
#import <Security/Security.h>

#include "drivers/driver.hpp"

namespace dbui::secrets {
namespace {

struct CFHolder {
  CFTypeRef ref = nullptr;
  explicit CFHolder(CFTypeRef r = nullptr) : ref(r) {}
  ~CFHolder() {
    if (ref) CFRelease(ref);
  }
  CFHolder(const CFHolder&) = delete;
  CFHolder& operator=(const CFHolder&) = delete;
};

CFStringRef cfString(const std::string& s) {
  return CFStringCreateWithBytes(nullptr, reinterpret_cast<const UInt8*>(s.data()), static_cast<CFIndex>(s.size()),
                                 kCFStringEncodingUTF8, false);
}

std::string statusMessage(OSStatus status) {
  CFHolder msg(SecCopyErrorMessageString(status, nullptr));
  std::string text = "Keychain error " + std::to_string(status);
  if (msg.ref) {
    char buf[512];
    if (CFStringGetCString(static_cast<CFStringRef>(msg.ref), buf, sizeof buf, kCFStringEncodingUTF8)) {
      text += ": ";
      text += buf;
    }
  }
  return text;
}

/** Base query for one item: class, service, account. */
CFMutableDictionaryRef baseQuery(const std::string& ref) {
  CFMutableDictionaryRef q =
      CFDictionaryCreateMutable(nullptr, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFHolder service(cfString(kService));
  CFHolder account(cfString(ref));
  CFDictionarySetValue(q, kSecClass, kSecClassGenericPassword);
  CFDictionarySetValue(q, kSecAttrService, service.ref);
  CFDictionarySetValue(q, kSecAttrAccount, account.ref);
  return q;
}

void checkRef(const std::string& ref) {
  if (ref.empty()) throw DriverError("BAD_REQUEST", "secret ref is empty");
}

}  // namespace

void set(const std::string& ref, const std::string& value) {
  checkRef(ref);
  CFHolder query(baseQuery(ref));
  CFHolder data(CFDataCreate(nullptr, reinterpret_cast<const UInt8*>(value.data()), static_cast<CFIndex>(value.size())));

  CFMutableDictionaryRef attrs =
      CFDictionaryCreateMutable(nullptr, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFHolder attrsHolder(attrs);
  CFDictionarySetValue(attrs, kSecValueData, data.ref);

  OSStatus status = SecItemUpdate(static_cast<CFDictionaryRef>(query.ref), attrs);
  if (status == errSecItemNotFound) {
    auto add = static_cast<CFMutableDictionaryRef>(const_cast<void*>(query.ref));
    CFDictionarySetValue(add, kSecValueData, data.ref);
    CFHolder label(cfString("dbui: " + ref));
    CFDictionarySetValue(add, kSecAttrLabel, label.ref);
    CFDictionarySetValue(add, kSecAttrAccessible, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly);
    status = SecItemAdd(add, nullptr);
  }
  if (status != errSecSuccess) throw DriverError("KEYCHAIN", statusMessage(status));
}

std::optional<std::string> get(const std::string& ref) {
  checkRef(ref);
  CFHolder query(baseQuery(ref));
  auto q = static_cast<CFMutableDictionaryRef>(const_cast<void*>(query.ref));
  CFDictionarySetValue(q, kSecReturnData, kCFBooleanTrue);
  CFDictionarySetValue(q, kSecMatchLimit, kSecMatchLimitOne);
  CFTypeRef out = nullptr;
  OSStatus status = SecItemCopyMatching(q, &out);
  CFHolder result(out);
  if (status == errSecItemNotFound) return std::nullopt;
  if (status != errSecSuccess) throw DriverError("KEYCHAIN", statusMessage(status));
  auto data = static_cast<CFDataRef>(result.ref);
  return std::string(reinterpret_cast<const char*>(CFDataGetBytePtr(data)), static_cast<std::size_t>(CFDataGetLength(data)));
}

bool remove(const std::string& ref) {
  checkRef(ref);
  CFHolder query(baseQuery(ref));
  OSStatus status = SecItemDelete(static_cast<CFDictionaryRef>(query.ref));
  if (status == errSecItemNotFound) return false;
  if (status != errSecSuccess) throw DriverError("KEYCHAIN", statusMessage(status));
  return true;
}

}  // namespace dbui::secrets
