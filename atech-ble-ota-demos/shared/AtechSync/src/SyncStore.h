// SyncStore.h: the versioned key-value table behind AtechSync. Every key carries
// (revision, writer MAC); SyncStore decides, with that pair alone, whether an incoming entry is
// newer, identical, stale or invalid. No clocks are involved. Portable C++ (host-tested).
#pragma once

#include "SyncTypes.h"

namespace atech {
namespace syncproto {

class SyncStore {
public:
  enum class Apply : uint8_t { Applied, Duplicate, Stale, Rejected };

  SyncStore();

  // A local write: revision = the known revision for the key + 1, writer = the given MAC.
  // False when the key or value is invalid or the table is full. `result` receives the entry.
  bool setLocal(const char *key, ValueType type, const char *value, const uint8_t writer[6], SyncEntry *result);
  // A remote entry: Applied when newer than the local version (or the key is new), Duplicate
  // when identical, Stale when older, Rejected when invalid or the table is full.
  Apply applyRemote(const SyncEntry &incoming);

  const SyncEntry *find(const char *key) const;
  size_t count() const { return _count; }
  const SyncEntry *at(size_t index) const { return index < _count ? &_entries[index] : nullptr; }
  void clear() { _count = 0; }

  // XOR of a per-entry FNV-1a hash over key, revision and writer: order independent, so two
  // boards holding the same versions agree whatever order they learned them in.
  uint32_t digest() const;

  // Blob for NVS: count, then per entry keyLen, key, type, valueLen, value, revision, writer.
  size_t serialize(uint8_t *out, size_t cap) const;
  // False (and the table left empty) on a truncated, oversized or invalid blob.
  bool deserialize(const uint8_t *in, size_t len);

  static bool validKey(const char *key);
  static bool validValue(ValueType type, const char *value);

private:
  SyncEntry *findMutable(const char *key);
  SyncEntry _entries[MAX_KEYS];
  size_t _count;
};

}  // namespace syncproto
}  // namespace atech
