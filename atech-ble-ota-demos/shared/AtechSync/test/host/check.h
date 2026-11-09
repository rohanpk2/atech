// Minimal host-side check macros for the AtechSync engine tests (no framework dependency).
#pragma once
#include <cstdio>
#include <cstring>

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond)                                                                   \
  do {                                                                                \
    ++g_checks;                                                                       \
    if (!(cond)) { ++g_failures; std::printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); } \
  } while (0)

#define CHECK_EQ(actual, expected)                                                    \
  do {                                                                                \
    ++g_checks;                                                                       \
    auto check_a = (actual);                                                          \
    auto check_e = (expected);                                                        \
    if (!(check_a == check_e)) {                                                      \
      ++g_failures;                                                                   \
      std::printf("  FAIL %s:%d: %s == %s (got %lld, expected %lld)\n", __FILE__, __LINE__, #actual, #expected, \
                  (long long)check_a, (long long)check_e);                            \
    }                                                                                 \
  } while (0)

#define CHECK_STR(actual, expected)                                                   \
  do {                                                                                \
    ++g_checks;                                                                       \
    const char *check_a = (actual);                                                   \
    const char *check_e = (expected);                                                 \
    if (std::strcmp(check_a, check_e) != 0) {                                         \
      ++g_failures;                                                                   \
      std::printf("  FAIL %s:%d: %s == \"%s\" (got \"%s\")\n", __FILE__, __LINE__, #actual, check_e, check_a); \
    }                                                                                 \
  } while (0)

#define RUN(fn)                                                                       \
  do { std::printf("- %s\n", #fn); fn(); } while (0)

static int report(const char *suite) {
  std::printf("%s: %d checks, %d failures\n", suite, g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
