// Build metadata for the stock images. The AI firmware builder overwrites this
// file inside its isolated workspace with the job's build id, app name,
// version and target device; the checked-in copy keeps the stock values.
#pragma once

#ifndef DEMO_VERSION
#define DEMO_VERSION 1
#endif

#ifndef ATECH_BUILD_ID
#define ATECH_BUILD_ID "stock"
#endif

#ifndef ATECH_APP_NAME
#if DEMO_VERSION == 1
#define ATECH_APP_NAME "blue default"
#else
#define ATECH_APP_NAME "green default"
#endif
#endif

#ifndef ATECH_APP_VERSION
#define ATECH_APP_VERSION DEMO_VERSION
#endif

#ifndef ATECH_TARGET_DEVICE_ID
#define ATECH_TARGET_DEVICE_ID ""
#endif
