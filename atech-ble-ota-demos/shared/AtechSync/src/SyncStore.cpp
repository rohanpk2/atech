// SyncStore.cpp: see SyncStore.h.
#include "SyncStore.h"

#include <errno.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

namespace atech {
namespace syncproto {

int compareVersion(uint32_t revA, const uint8_t *writerA, uint32_t revB, const uint8_t *writerB) {
  if (revA != revB) return revA > revB ? 1 : -1;
  const int byMac = memcmp(writerA, writerB, 6);
  return byMac > 0 ? 1 : byMac < 0 ? -1 : 0;
}

const char *valueTypeName(ValueType type) {
  switch (type) {
    case ValueType::Bool: return "bool";
    case ValueType::Int: return "int";
    case ValueType::Float: return "float";
    case ValueType::String: return "string";
    case ValueType::Json: return "json";
    default: return "unknown";
  }
}

bool parseValueType(const char *text, ValueType &out) {
  if (!text) return false;
  if (strcmp(text, "bool") == 0) { out = ValueType::Bool; return true; }
  if (strcmp(text, "int") == 0) { out = ValueType::Int; return true; }
  if (strcmp(text, "float") == 0) { out = ValueType::Float; return true; }
  if (strcmp(text, "string") == 0) { out = ValueType::String; return true; }
  if (strcmp(text, "json") == 0) { out = ValueType::Json; return true; }
  return false;
}

bool validValueType(uint8_t raw) {
  return raw >= static_cast<uint8_t>(ValueType::Bool) && raw <= static_cast<uint8_t>(ValueType::Json);
}

namespace {

uint32_t fnv1a(uint32_t hash, const uint8_t *data, size_t len) {
  for (size_t i = 0; i < len; ++i) { hash ^= data[i]; hash *= 16777619u; }
  return hash;
}

uint32_t entryHash(const SyncEntry &e) {
  uint32_t h = 2166136261u;
  h = fnv1a(h, reinterpret_cast<const uint8_t *>(e.key), strlen(e.key));
  const uint8_t rev[4] = {uint8_t(e.revision), uint8_t(e.revision >> 8), uint8_t(e.revision >> 16), uint8_t(e.revision >> 24)};
  h = fnv1a(h, rev, 4);
  h = fnv1a(h, e.writer, 6);
  return h ? h : 0x9E3779B9u;   // never contribute zero, so an entry always changes the digest
}

bool allDigits(const char *s, size_t n) {
  if (n == 0) return false;
  for (size_t i = 0; i < n; ++i) if (s[i] < '0' || s[i] > '9') return false;
  return true;
}

}  // namespace

SyncStore::SyncStore() : _count(0) { memset(_entries, 0, sizeof(_entries)); }

bool SyncStore::validKey(const char *key) {
  if (!key) return false;
  const size_t n = strnlen(key, MAX_KEY + 1);
  if (n == 0 || n > MAX_KEY) return false;
  for (size_t i = 0; i < n; ++i) {
    const char c = key[i];
    const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
    if (!ok) return false;
  }
  return true;
}

bool SyncStore::validValue(ValueType type, const char *value) {
  if (!value) return false;
  const size_t n = strnlen(value, MAX_VALUE + 1);
  if (n > MAX_VALUE) return false;
  switch (type) {
    case ValueType::Bool:
      return strcmp(value, "true") == 0 || strcmp(value, "false") == 0;
    case ValueType::Int: {
      const char *digits = value[0] == '-' ? value + 1 : value;
      if (!allDigits(digits, n - (digits - value)) || n > 11) return false;
      errno = 0;
      const long long parsed = strtoll(value, nullptr, 10);
      return errno == 0 && parsed >= -2147483648LL && parsed <= 2147483647LL;
    }
    case ValueType::Float: {
      if (n == 0) return false;
      char *end = nullptr;
      const double parsed = strtod(value, &end);
      return end == value + n && isfinite(parsed);
    }
    case ValueType::String:
      return true;
    case ValueType::Json:
      return n > 0 && (value[0] == '{' || value[0] == '[');
    default:
      return false;
  }
}

SyncEntry *SyncStore::findMutable(const char *key) {
  for (size_t i = 0; i < _count; ++i) if (strcmp(_entries[i].key, key) == 0) return &_entries[i];
  return nullptr;
}

const SyncEntry *SyncStore::find(const char *key) const {
  if (!key) return nullptr;
  for (size_t i = 0; i < _count; ++i) if (strcmp(_entries[i].key, key) == 0) return &_entries[i];
  return nullptr;
}

bool SyncStore::setLocal(const char *key, ValueType type, const char *value, const uint8_t writer[6], SyncEntry *result) {
  if (!validKey(key) || !validValueType(static_cast<uint8_t>(type)) || !validValue(type, value) || !writer) return false;
  SyncEntry *entry = findMutable(key);
  if (!entry) {
    if (_count >= MAX_KEYS) return false;
    entry = &_entries[_count++];
    memset(entry, 0, sizeof(*entry));
    strncpy(entry->key, key, MAX_KEY);
  }
  entry->type = type;
  strncpy(entry->value, value, MAX_VALUE);
  entry->value[MAX_VALUE] = 0;
  entry->revision += 1;
  memcpy(entry->writer, writer, 6);
  if (result) *result = *entry;
  return true;
}

SyncStore::Apply SyncStore::applyRemote(const SyncEntry &incoming) {
  if (!validKey(incoming.key) || !validValueType(static_cast<uint8_t>(incoming.type)) ||
      !validValue(incoming.type, incoming.value) || incoming.revision == 0) {
    return Apply::Rejected;
  }
  SyncEntry *entry = findMutable(incoming.key);
  if (!entry) {
    if (_count >= MAX_KEYS) return Apply::Rejected;
    entry = &_entries[_count++];
    memset(entry, 0, sizeof(*entry));
    strncpy(entry->key, incoming.key, MAX_KEY);
  } else {
    const int order = compareVersion(incoming.revision, incoming.writer, entry->revision, entry->writer);
    if (order == 0) return Apply::Duplicate;
    if (order < 0) return Apply::Stale;
  }
  entry->type = incoming.type;
  strncpy(entry->value, incoming.value, MAX_VALUE);
  entry->value[MAX_VALUE] = 0;
  entry->revision = incoming.revision;
  memcpy(entry->writer, incoming.writer, 6);
  return Apply::Applied;
}

uint32_t SyncStore::digest() const {
  uint32_t out = 0x811C9DC5u;
  for (size_t i = 0; i < _count; ++i) out ^= entryHash(_entries[i]);
  return out;
}

size_t SyncStore::serialize(uint8_t *out, size_t cap) const {
  if (!out || cap < 1) return 0;
  size_t at = 0;
  out[at++] = uint8_t(_count);
  for (size_t i = 0; i < _count; ++i) {
    const SyncEntry &e = _entries[i];
    const size_t keyLen = strlen(e.key);
    const size_t valueLen = strlen(e.value);
    if (at + 1 + keyLen + 1 + 1 + valueLen + 4 + 6 > cap) return 0;
    out[at++] = uint8_t(keyLen);
    memcpy(out + at, e.key, keyLen); at += keyLen;
    out[at++] = static_cast<uint8_t>(e.type);
    out[at++] = uint8_t(valueLen);
    memcpy(out + at, e.value, valueLen); at += valueLen;
    out[at++] = uint8_t(e.revision); out[at++] = uint8_t(e.revision >> 8);
    out[at++] = uint8_t(e.revision >> 16); out[at++] = uint8_t(e.revision >> 24);
    memcpy(out + at, e.writer, 6); at += 6;
  }
  return at;
}

bool SyncStore::deserialize(const uint8_t *in, size_t len) {
  clear();
  if (!in || len < 1) return false;
  size_t at = 0;
  const size_t count = in[at++];
  if (count > MAX_KEYS) return false;
  for (size_t i = 0; i < count; ++i) {
    SyncEntry e;
    memset(&e, 0, sizeof(e));
    if (at + 1 > len) { clear(); return false; }
    const size_t keyLen = in[at++];
    if (keyLen == 0 || keyLen > MAX_KEY || at + keyLen + 2 > len) { clear(); return false; }
    memcpy(e.key, in + at, keyLen); at += keyLen;
    const uint8_t rawType = in[at++];
    const size_t valueLen = in[at++];
    if (!validValueType(rawType) || valueLen > MAX_VALUE || at + valueLen + 10 > len) { clear(); return false; }
    e.type = static_cast<ValueType>(rawType);
    memcpy(e.value, in + at, valueLen); at += valueLen;
    e.revision = uint32_t(in[at]) | (uint32_t(in[at + 1]) << 8) | (uint32_t(in[at + 2]) << 16) | (uint32_t(in[at + 3]) << 24);
    at += 4;
    memcpy(e.writer, in + at, 6); at += 6;
    if (!validKey(e.key) || !validValue(e.type, e.value) || find(e.key)) { clear(); return false; }
    _entries[_count++] = e;
  }
  if (at != len) { clear(); return false; }
  return true;
}

}  // namespace syncproto
}  // namespace atech
