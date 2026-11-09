// AtechSync.h: board-to-board state synchronization over ESP-NOW, shared by both Atech demos.
// The portable engine (SyncEngine.h) decides what to send and what to apply; this class is the
// ESP32 side: ESP-NOW peers and channel policy, AES-128-GCM sealing of every frame with the
// pairing key, NVS persistence of the peer table and the state table, FreeRTOS queues between
// the Wi-Fi task, the main loop and the application task, a read/notify GATT status service, a
// serial console ("sync ..."), and one command entry point used by the Bluetooth setup session,
// the LAN service and the cloud agent. Part of the protected core; generated code sees only
// AtechSyncApp.h. The wire limits and timings are mirrored by builder/lib/fake-sync.js.
#pragma once

#include <Arduino.h>

class BLEServer;
class AtechWifiLan;

struct AtechSyncConfig {
  BLEServer *server;                  // optional: status service a7ec0300 (read a7ec0301, notify a7ec0302)
  AtechWifiLan *lan;                  // keeps the Wi-Fi driver started (radio hold) and reports the station state
  bool (*otaBusy)();                  // true while any OTA transport owns flash: the engine only acknowledges
  const char *preferencesNamespace;   // NVS namespace ("atech_sync")
  bool serialConsole;                 // accept "sync ..." commands on the serial console
};

struct AtechSyncResult {
  bool ok;
  String error;
  String code;                        // the pairing code, for op=code
};

class AtechSync {
public:
  AtechSync();
  ~AtechSync();
  AtechSync(const AtechSync &) = delete;
  AtechSync &operator=(const AtechSync &) = delete;

  // Loads the peer and state tables, starts ESP-NOW (retried from loop() until the Wi-Fi driver
  // is up), creates the GATT service when a server is given.
  bool begin(const AtechSyncConfig &config);
  // Main-loop service: frames, retries, heartbeats, persistence, channel policy, BLE notifications
  // and the serial console. Nothing heavy runs in the ESP-NOW callbacks.
  void loop();

  // One command entry point for every control path. `form` is application/x-www-form-urlencoded:
  //   op=code                      issue a pairing code (10 min window)        privileged
  //   op=pair&code=ATSYNC1-...     pair with the board that issued the code    privileged
  //   op=unpair                    forget every peer                           privileged
  //   op=set&key=..&value=..[&type=bool|int|float|string|json]   (type inferred when absent)
  //   op=toggle&key=..             flip a boolean
  //   op=event&name=..[&payload=..]
  //   op=status                    no-op (callers read statusJson())
  // Pairing changes are refused unless `privileged` (serial console, authorized Bluetooth session,
  // or the backend holding the board's token).
  AtechSyncResult command(const String &form, bool privileged);

  String statusJson();          // full status: identity, channel, peers, state, counters
  String compactStatusJson();   // for the cloud poll: paired, connected, peer, peerState, code, state
  bool handleSerialLine(const String &line);   // true when the line was a "sync" command
  bool isPaired() const;
  bool isConnected() const;
  bool emitEvent(const char *name, const char *payload = "");
  const String &lastError() const;

  struct Impl;

private:
  Impl *_impl;
};
