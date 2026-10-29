// Native messaging framing: a 4-byte native-endian length, then that many bytes of UTF-8 JSON.
#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace dbui::framing {

/** Largest frame the runner accepts from Chrome. Chrome allows up to 4 GB; we cap it. */
inline constexpr std::uint32_t kMaxInboundFrame = 256u * 1024u * 1024u;
/** Chrome rejects runner → Chrome messages of 1 MB or more. */
inline constexpr std::size_t kMaxOutboundFrame = 1024u * 1024u;

std::string encode(std::string_view payload);

/**
 * Takes one complete frame off the front of `buffer` if there is one.
 * Throws std::runtime_error when the declared length is over kMaxInboundFrame.
 */
std::optional<std::string> decode(std::string& buffer);

/** Blocking read of one frame from `fd`. nullopt on EOF (also mid-frame). Throws on bad length. */
std::optional<std::string> readFrame(int fd);

/** Writes one frame to `fd`, retrying short writes. Returns false if the pipe is gone. */
bool writeFrame(int fd, std::string_view payload);

}  // namespace dbui::framing
