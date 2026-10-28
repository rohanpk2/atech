#include "AtechWifiOta.h"

#include <DNSServer.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_app_desc.h>
#include <esp_app_format.h>
#include <esp_err.h>
#include <esp_mac.h>
#include <esp_ota_ops.h>
#include <esp_system.h>
#include <mbedtls/sha256.h>

#include <algorithm>
#include <cstring>

namespace {

const IPAddress AP_IP(192, 168, 4, 1);
const IPAddress AP_MASK(255, 255, 255, 0);
constexpr uint16_t DNS_PORT = 53;
constexpr size_t APP_PREFIX_SIZE =
    sizeof(esp_image_header_t) + sizeof(esp_image_segment_header_t) +
    sizeof(uint32_t);
constexpr char CREDENTIAL_ALPHABET[] =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

const char PORTAL_HTML[] PROGMEM = R"ATECHHTML(
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>Atech Wi-Fi OTA</title>
  <style>
    :root{color-scheme:light dark;--bg:#07111f;--card:#111f31;--ink:#eef7ff;--muted:#a9bfd2;--line:#29425b;--accent:#38bdf8;--ok:#4ade80;--bad:#fb7185}
    *{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#07111f,#10263b);color:var(--ink);font:16px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh}
    main{width:min(720px,calc(100% - 28px));margin:0 auto;padding:32px 0 56px}h1{font-size:clamp(1.8rem,7vw,2.8rem);margin:.1em 0}h2{font-size:1.05rem;margin:0 0 14px}.eyebrow{color:var(--accent);font-weight:750;letter-spacing:.08em;text-transform:uppercase;font-size:.76rem}.card{background:var(--card);background:color-mix(in srgb,var(--card) 94%,transparent);border:1px solid var(--line);border-radius:18px;padding:20px;margin-top:18px;box-shadow:0 18px 50px #0005}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 20px}.label{color:var(--muted);font-size:.8rem}.value{font-weight:700;overflow-wrap:anywhere;margin-top:2px}.status{padding:12px;border-radius:12px;background:#07111f;border:1px solid var(--line);margin:14px 0;color:var(--muted)}.status.ok{border-color:var(--ok);color:var(--ok)}.status.bad{border-color:var(--bad);color:var(--bad)}label{display:block;color:var(--muted);font-weight:650;margin:14px 0 7px}input[type=password],input[type=file]{width:100%;border:1px solid var(--line);border-radius:11px;padding:12px;background:#07111f;color:var(--ink)}button{border:0;border-radius:11px;padding:12px 17px;font:inherit;font-weight:800;background:var(--accent);color:#04111b;cursor:pointer;width:100%;margin-top:14px}button.secondary{background:transparent;color:var(--muted);border:1px solid var(--line)}button:disabled{opacity:.45;cursor:not-allowed}.bar{height:12px;border-radius:999px;background:#07111f;overflow:hidden;border:1px solid var(--line);margin-top:13px}.bar>span{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--ok));transition:width .15s}.small{font-size:.86rem;color:var(--muted)}code{font-size:.86em}noscript{color:var(--bad)}@media(max-width:520px){main{padding-top:20px}.grid{grid-template-columns:1fr}.card{padding:17px}}
  </style>
</head>
<body><main>
  <div class="eyebrow">Device-hosted update portal</div>
  <h1>Atech Wi-Fi OTA</h1>
  <p class="small">Upload an application <code>firmware.bin</code>. Bootloaders, partition tables, and merged flash images are rejected.</p>
  <noscript>JavaScript is required to upload firmware and display progress.</noscript>

  <section class="card" aria-labelledby="device-title">
    <h2 id="device-title">Device status</h2>
    <div class="grid">
      <div><div class="label">Device</div><div class="value" id="device">Checking…</div></div>
      <div><div class="label">Firmware</div><div class="value" id="version">Checking…</div></div>
      <div><div class="label">Network</div><div class="value" id="ssid">Checking…</div></div>
      <div><div class="label">Portal</div><div class="value" id="connection" role="status" aria-live="polite">Connecting…</div></div>
    </div>
    <div id="postBoot" class="status" role="status" aria-live="polite" hidden></div>
  </section>

  <section class="card" aria-labelledby="deploy-title">
    <h2 id="deploy-title">Deploy application firmware</h2>
    <label for="token">OTA authorization code</label>
    <input id="token" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Recorded during USB provisioning">
    <label for="firmware">Application firmware.bin</label>
    <input id="firmware" type="file" accept=".bin,application/octet-stream">
    <div id="progressBar" class="bar" role="progressbar" aria-label="Firmware upload" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="bar"></span></div>
    <div id="progress" class="small" role="status" aria-live="polite">No file selected.</div>
    <div id="result" class="status" role="status" aria-live="polite">Ready. Keep this device powered throughout upload and verification.</div>
    <button id="deploy" disabled>Deploy Firmware</button>
    <button id="exit" class="secondary">Exit Wi-Fi OTA mode</button>
    <p class="small">Upload progress only confirms browser-to-device transfer. Success is shown only after the ESP32 validates the complete image and selects the inactive OTA partition.</p>
  </section>
</main>
<script>
(() => {
  const $ = id => document.getElementById(id);
  const fileInput=$('firmware'), tokenInput=$('token'), deploy=$('deploy'), exitButton=$('exit'), result=$('result'), bar=$('bar'), progress=$('progress'), progressBar=$('progressBar');
  let selected=null, crcHex='', portalStatus=null, portalBusy=false, refreshInFlight=false, fileGeneration=0;
  const setResult=(text,kind='')=>{result.textContent=text;result.className='status '+kind};
  const setProgress=pct=>{const value=Math.max(0,Math.min(100,pct));bar.style.width=value+'%';progressBar.setAttribute('aria-valuenow',String(value))};
  const fmt=n=>n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KiB':(n/1048576).toFixed(2)+' MiB';
  const crcTable=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0}return t})();
  async function crc32(file){let crc=0xffffffff;const step=256*1024;for(let p=0;p<file.size;p+=step){const bytes=new Uint8Array(await file.slice(p,p+step).arrayBuffer());for(const b of bytes)crc=crcTable[(crc^b)&255]^(crc>>>8);progress.textContent=`Checking file integrity… ${Math.min(100,Math.round((p+bytes.length)*100/file.size))}%`}return ((crc^0xffffffff)>>>0).toString(16).padStart(8,'0')}
  async function refresh(){if(refreshInFlight)return portalStatus;refreshInFlight=true;try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);const s=await r.json();portalStatus=s;$('device').textContent=s.device;$('version').textContent=s.version;$('ssid').textContent=s.ssid;$('connection').textContent=`Online · ${s.clients} client${s.clients===1?'':'s'}`;if(s.post_update_boot){const p=$('postBoot');p.hidden=false;p.className='status ok';p.textContent=s.previous_version&&s.previous_version!==s.version?`Post-update boot verified: ${s.previous_version} → ${s.version}.`:`Post-update portal restored. Running firmware reports ${s.version}; confirm the intended version.`}else if(s.ota_state==='failed'&&s.error&&!portalBusy){setResult(`Previous update failed: ${s.error}`,'bad')}return s}catch(e){$('connection').textContent='Reconnecting…';throw e}finally{refreshInFlight=false}}
  async function preflight(file){if(!file.name.toLowerCase().endsWith('.bin'))throw new Error('Choose the application firmware.bin file, not a source or archive.');if(file.size<36)throw new Error('The file is too small to be an ESP application image.');if(portalStatus?.partition_capacity&&file.size>portalStatus.partition_capacity)throw new Error(`The file exceeds this device's ${fmt(portalStatus.partition_capacity)} OTA slot.`);const b=new Uint8Array(await file.slice(0,36).arrayBuffer());const v=new DataView(b.buffer,b.byteOffset,b.byteLength);if(b[0]!==0xe9)throw new Error('The file is not an ESP application image.');if(v.getUint16(12,true)!==9)throw new Error('The firmware target is not ESP32-S3.');if((b[3]>>4)!==4)throw new Error('The firmware target is not the configured 16 MB board.');if(v.getUint32(32,true)!==0xabcd5432)throw new Error('Choose application firmware.bin, not a bootloader or merged image.')}
  fileInput.addEventListener('change',async()=>{const generation=++fileGeneration;const candidate=fileInput.files[0]||null;selected=null;crcHex='';deploy.disabled=true;setProgress(0);if(!candidate){portalBusy=false;progress.textContent='No file selected.';return}portalBusy=true;progress.textContent=`Checking ${candidate.name} (${fmt(candidate.size)})…`;try{await preflight(candidate);const candidateCrc=await crc32(candidate);if(generation!==fileGeneration)return;selected=candidate;crcHex=candidateCrc;progress.textContent=`Ready: ${fmt(candidate.size)} · CRC32 ${crcHex}`;deploy.disabled=false;setResult('File checked locally. Ready to upload.')}catch(e){if(generation!==fileGeneration)return;setResult(e.message,'bad');progress.textContent='File rejected before upload.'}finally{if(generation===fileGeneration)portalBusy=false}});
  deploy.addEventListener('click',()=>{if(!selected||!crcHex)return;const token=tokenInput.value.trim();if(!token){setResult('Enter the separate OTA authorization code printed during USB provisioning.','bad');tokenInput.focus();return}portalBusy=true;deploy.disabled=true;exitButton.disabled=true;fileInput.disabled=true;tokenInput.disabled=true;setProgress(0);setResult('Uploading to the inactive OTA partition…');const body=new FormData();body.append('firmware',selected,selected.name);const xhr=new XMLHttpRequest();xhr.open('POST','/api/update');xhr.responseType='json';xhr.timeout=600000;xhr.setRequestHeader('X-Atech-OTA-Key',token);xhr.setRequestHeader('X-Atech-Firmware-Size',String(selected.size));xhr.setRequestHeader('X-Atech-Firmware-CRC32',crcHex);xhr.upload.onprogress=e=>{if(e.lengthComputable){const pct=Math.min(100,Math.round(e.loaded*100/e.total));setProgress(pct);progress.textContent=`HTTP upload ${pct}% · ${fmt(e.loaded)} of ${fmt(e.total)} (includes form overhead)`;if(pct===100)setResult('Browser upload complete; waiting for device receipt and flash verification. Do not reset.') }};xhr.onerror=()=>done('Connection lost. The incomplete inactive image was not selected; reconnect and retry.','bad');xhr.ontimeout=()=>done('Upload timed out. Reconnect to the hotspot; the device will discard the incomplete image.','bad');xhr.onabort=()=>done('Upload canceled. The incomplete inactive image was discarded.','bad');xhr.onload=()=>{const data=xhr.response||{};if(xhr.status===200&&data.ok){setProgress(100);setResult(`Flash verified (${fmt(data.bytes)}; SHA-256 ${data.sha256}). Rebooting into the new image…`,'ok');progress.textContent='Transfer complete; device-side flash verification passed.';waitForReboot()}else done(data.error||`Update failed (HTTP ${xhr.status}).`,'bad')};xhr.send(body)});
  function done(message,kind){portalBusy=false;setResult(message,kind);deploy.disabled=!selected;exitButton.disabled=false;fileInput.disabled=false;tokenInput.disabled=false}
  async function waitForReboot(){let attempts=0;const poll=async()=>{attempts++;try{const s=await refresh();if(s.post_update_boot){done(`New firmware is online: ${s.version}. Wi-Fi access remains available for verification.`,'ok');return}}catch(e){}if(attempts<45)setTimeout(poll,2000);else done('The board rebooted, but this browser could not reconnect. Rejoin the same hotspot and reopen http://192.168.4.1 to verify.','bad')};setTimeout(poll,3500)}
  $('exit').addEventListener('click',async()=>{const token=tokenInput.value.trim();if(!token){setResult('Enter the OTA authorization code before exiting Wi-Fi mode.','bad');return}try{const r=await fetch('/api/exit',{method:'POST',headers:{'X-Atech-OTA-Key':token}});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request rejected');setResult('Wi-Fi OTA is closing. The board is returning to BLE mode.','ok')}catch(e){setResult('Could not exit Wi-Fi mode: '+e.message,'bad')}});
  refresh().catch(()=>{});setInterval(()=>{if(!portalBusy)refresh().catch(()=>{})},5000);
})();
</script></body></html>
)ATECHHTML";

String jsonEscape(const String &input) {
  String output;
  output.reserve(input.length() + 8);
  for (size_t i = 0; i < input.length(); ++i) {
    const char c = input[i];
    switch (c) {
      case '\\': output += F("\\\\"); break;
      case '"': output += F("\\\""); break;
      case '\n': output += F("\\n"); break;
      case '\r': output += F("\\r"); break;
      case '\t': output += F("\\t"); break;
      default:
        if (static_cast<uint8_t>(c) >= 0x20) output += c;
        break;
    }
  }
  return output;
}

String randomCredential(size_t length) {
  String result;
  result.reserve(length);
  uint32_t randomValue = 0;
  for (size_t i = 0; i < length; ++i) {
    if ((i % 4) == 0) esp_fill_random(&randomValue, sizeof(randomValue));
    const uint8_t byteValue = uint8_t(randomValue >> ((i % 4) * 8));
    result += CREDENTIAL_ALPHABET[byteValue % (sizeof(CREDENTIAL_ALPHABET) - 1)];
  }
  return result;
}

bool constantTimeEquals(const String &left, const String &right) {
  if (left.length() != right.length()) return false;
  uint8_t difference = 0;
  for (size_t i = 0; i < left.length(); ++i) {
    difference |= static_cast<uint8_t>(left[i] ^ right[i]);
  }
  return difference == 0;
}

uint32_t updateCrc32(uint32_t crc, const uint8_t *data, size_t length) {
  for (size_t i = 0; i < length; ++i) {
    crc ^= data[i];
    for (uint8_t bit = 0; bit < 8; ++bit) {
      crc = (crc >> 1) ^ ((crc & 1U) ? 0xEDB88320UL : 0UL);
    }
  }
  return crc;
}

String sha256Hex(const uint8_t digest[32]) {
  static constexpr char HEX_DIGITS[] = "0123456789abcdef";
  char text[65];
  for (size_t i = 0; i < 32; ++i) {
    text[i * 2] = HEX_DIGITS[digest[i] >> 4];
    text[i * 2 + 1] = HEX_DIGITS[digest[i] & 0x0f];
  }
  text[64] = '\0';
  return String(text);
}

bool parseUnsigned(const String &text, uint32_t &value, int base = 10) {
  if (text.isEmpty()) return false;
  char *end = nullptr;
  errno = 0;
  const unsigned long parsed = strtoul(text.c_str(), &end, base);
  if (errno != 0 || end == text.c_str() || *end != '\0' || parsed > UINT32_MAX) {
    return false;
  }
  value = static_cast<uint32_t>(parsed);
  return true;
}

}  // namespace

struct AtechWifiOtaPortal::Impl {
  enum class UploadState { Idle, Receiving, Verifying, Verified, Failed };

  AtechWifiOtaConfig config = {};
  String deviceName;
  String firmwareVersion;
  String ssidPrefix;
  String imageIdentity;
  String preferencesNamespace;
  String apPassword;
  String otaToken;
  String apSsid;
  String error;
  String imageSha256;
  String previousVersion;
  WebServer *server = nullptr;
  DNSServer *dns = nullptr;
  const esp_partition_t *targetPartition = nullptr;
  esp_ota_handle_t otaHandle = 0;
  mbedtls_sha256_context shaContext;
  bool shaStarted = false;
  bool initialized = false;
  bool active = false;
  bool uploading = false;
  bool otaHandleActive = false;
  bool headerValidated = false;
  bool postUpdateBoot = false;
  bool resumeMarkerNeedsClear = false;
  bool buttonWasPressed = false;
  bool buttonHandled = false;
  bool ignoreButtonUntilRelease = false;
  uint8_t appPrefix[APP_PREFIX_SIZE] = {};
  size_t appPrefixLength = 0;
  size_t identityMatchLength = 0;
  bool identityFound = false;
  uint32_t expectedBytes = 0;
  uint32_t receivedBytes = 0;
  uint32_t expectedCrc = 0;
  uint32_t runningCrc = 0xFFFFFFFFUL;
  uint32_t lastActivityMs = 0;
  uint32_t buttonPressedMs = 0;
  uint32_t rebootAtMs = 0;
  uint32_t stopAtMs = 0;
  int responseStatus = 200;
  UploadState uploadState = UploadState::Idle;

  Impl() { mbedtls_sha256_init(&shaContext); }
  ~Impl() {
    abortUpload("Portal destroyed during upload", false);
    if (server) {
      server->stop();
      delete server;
    }
    if (dns) {
      dns->stop();
      delete dns;
    }
    mbedtls_sha256_free(&shaContext);
  }

  bool credentialsValid() const {
    return apPassword.length() >= 12 && apPassword.length() <= 63 &&
           otaToken.length() >= 16;
  }

  bool loadCredentials() {
    if (preferencesNamespace.isEmpty() || preferencesNamespace.length() > 15) {
      error = F("Preferences namespace must contain 1-15 characters");
      return false;
    }
    Preferences preferences;
    if (!preferences.begin(preferencesNamespace.c_str(), false)) {
      error = F("Could not open credential storage");
      return false;
    }

    const String passwordOverride = config.apPasswordOverride ? config.apPasswordOverride : "";
    const String tokenOverride = config.otaTokenOverride ? config.otaTokenOverride : "";
    if (!passwordOverride.isEmpty()) {
      apPassword = passwordOverride;
    } else {
      apPassword = preferences.getString("ap_pass", "");
      if (apPassword.length() < 12 || apPassword.length() > 63) {
        apPassword = randomCredential(18);
        if (preferences.putString("ap_pass", apPassword) != apPassword.length()) {
          preferences.end();
          error = F("Could not persist the device-specific Wi-Fi password");
          return false;
        }
      }
    }
    if (!tokenOverride.isEmpty()) {
      otaToken = tokenOverride;
    } else {
      otaToken = preferences.getString("ota_token", "");
      if (otaToken.length() < 16) {
        otaToken = randomCredential(24);
        if (preferences.putString("ota_token", otaToken) != otaToken.length()) {
          preferences.end();
          error = F("Could not persist the device-specific OTA token");
          return false;
        }
      }
    }

    postUpdateBoot = preferences.getBool("resume", false);
    if (postUpdateBoot) {
      previousVersion = preferences.getString("prev_ver", "");
      imageSha256 = preferences.getString("last_sha", "");
      resumeMarkerNeedsClear = true;
    }
    preferences.end();

    if (!credentialsValid()) {
      error = F("Wi-Fi password must be 12-63 characters and OTA token at least 16");
      return false;
    }
    return true;
  }

  void printCredentials() const {
    Serial.println(F("Wi-Fi OTA credentials (record securely during provisioning):"));
    Serial.printf("  SSID: %s\n", apSsid.c_str());
    Serial.printf("  WPA2 password: %s\n", apPassword.c_str());
    Serial.printf("  OTA authorization code: %s\n", otaToken.c_str());
    Serial.println(F("  Portal: http://192.168.4.1"));
  }

  bool authorize() {
    if (!server) return false;
    return constantTimeEquals(server->header("X-Atech-OTA-Key"), otaToken);
  }

  String uploadStateName() const {
    switch (uploadState) {
      case UploadState::Idle: return F("idle");
      case UploadState::Receiving: return F("receiving");
      case UploadState::Verifying: return F("verifying");
      case UploadState::Verified: return F("verified");
      case UploadState::Failed: return F("failed");
    }
    return F("unknown");
  }

  String statusJson() const {
    String json;
    json.reserve(560);
    json += F("{\"device\":\"");
    json += jsonEscape(deviceName);
    json += F("\",\"version\":\"");
    json += jsonEscape(firmwareVersion);
    json += F("\",\"ssid\":\"");
    json += jsonEscape(apSsid);
    json += F("\",\"ip\":\"192.168.4.1\",\"active\":");
    json += active ? F("true") : F("false");
    json += F(",\"clients\":");
    json += active ? String(WiFi.softAPgetStationNum()) : String(0);
    json += F(",\"ota_state\":\"");
    json += uploadStateName();
    json += F("\",\"received\":");
    json += String(receivedBytes);
    json += F(",\"expected\":");
    json += String(expectedBytes);
    json += F(",\"post_update_boot\":");
    json += postUpdateBoot ? F("true") : F("false");
    json += F(",\"previous_version\":\"");
    json += jsonEscape(previousVersion);
    json += F("\",\"last_image_sha256\":\"");
    json += jsonEscape(imageSha256);
    json += F("\",\"partition_capacity\":");
    json += targetPartition ? String(targetPartition->size) : String(0);
    json += F(",\"error\":\"");
    json += jsonEscape(error);
    json += F("\"}");
    return json;
  }

  void sendJson(int status, const String &body) {
    server->sendHeader(F("Cache-Control"), F("no-store"));
    server->send(status, F("application/json"), body);
  }

  void setFailure(const String &message, int status = 400) {
    error = message;
    responseStatus = status;
    uploadState = UploadState::Failed;
    Serial.printf("Wi-Fi OTA failed: %s\n", error.c_str());
  }

  void closeOtaHandle() {
    if (otaHandleActive) {
      esp_ota_abort(otaHandle);
      otaHandleActive = false;
      otaHandle = 0;
    }
  }

  void abortUpload(const String &message, bool recordFailure = true) {
    closeOtaHandle();
    if (shaStarted) {
      mbedtls_sha256_free(&shaContext);
      mbedtls_sha256_init(&shaContext);
      shaStarted = false;
    }
    uploading = false;
    if (recordFailure) setFailure(message);
  }

  bool validateAppPrefix() {
    if (appPrefixLength < APP_PREFIX_SIZE) {
      setFailure(F("Firmware ended before its application header"));
      return false;
    }
    esp_image_header_t imageHeader = {};
    memcpy(&imageHeader, appPrefix, sizeof(imageHeader));
    if (imageHeader.magic != ESP_IMAGE_HEADER_MAGIC) {
      setFailure(F("Not an ESP application image (bad magic byte)"));
      return false;
    }
    if (imageHeader.segment_count == 0 || imageHeader.segment_count > ESP_IMAGE_MAX_SEGMENTS) {
      setFailure(F("Invalid ESP application segment count"));
      return false;
    }
    if (imageHeader.chip_id != ESP_CHIP_ID_ESP32S3) {
      setFailure(F("Firmware target is not ESP32-S3"));
      return false;
    }
    if (imageHeader.spi_size != ESP_IMAGE_FLASH_SIZE_16MB) {
      setFailure(F("Firmware flash target is not the configured 16MB board"));
      return false;
    }
    uint32_t appDescriptorMagic = 0;
    memcpy(&appDescriptorMagic,
           appPrefix + sizeof(esp_image_header_t) + sizeof(esp_image_segment_header_t),
           sizeof(appDescriptorMagic));
    if (appDescriptorMagic != ESP_APP_DESC_MAGIC_WORD) {
      setFailure(F("Image is not an application firmware.bin (bootloader/merged images are rejected)"));
      return false;
    }

    const esp_err_t beginResult =
        esp_ota_begin(targetPartition, expectedBytes, &otaHandle);
    if (beginResult != ESP_OK) {
      setFailure(String(F("Could not begin inactive-partition update: ")) +
                 esp_err_to_name(beginResult), 500);
      return false;
    }
    otaHandleActive = true;
    const esp_err_t writeResult = esp_ota_write(otaHandle, appPrefix, appPrefixLength);
    if (writeResult != ESP_OK) {
      setFailure(String(F("Flash write failed: ")) + esp_err_to_name(writeResult), 500);
      closeOtaHandle();
      return false;
    }
    headerValidated = true;
    return true;
  }

  bool startUpload(HTTPUpload &upload) {
    if (uploading || rebootAtMs != 0) {
      setFailure(F("Another update is already active"), 409);
      return false;
    }
    error = "";
    imageSha256 = "";
    responseStatus = 200;
    receivedBytes = 0;
    expectedBytes = 0;
    expectedCrc = 0;
    runningCrc = 0xFFFFFFFFUL;
    appPrefixLength = 0;
    identityMatchLength = 0;
    identityFound = false;
    headerValidated = false;
    targetPartition = esp_ota_get_next_update_partition(nullptr);

    if (!authorize()) {
      setFailure(F("Invalid OTA authorization code"), 401);
      return false;
    }
    if (config.otherOtaBusy && config.otherOtaBusy()) {
      setFailure(F("Bluetooth OTA is active; disconnect and retry"), 409);
      return false;
    }
    String filename = upload.filename;
    filename.toLowerCase();
    if (!filename.endsWith(".bin")) {
      setFailure(F("Only application .bin files are accepted"));
      return false;
    }
    if (!parseUnsigned(server->header("X-Atech-Firmware-Size"), expectedBytes) ||
        expectedBytes < APP_PREFIX_SIZE) {
      setFailure(F("Missing or invalid firmware size"));
      return false;
    }
    if (!parseUnsigned(server->header("X-Atech-Firmware-CRC32"), expectedCrc, 16)) {
      setFailure(F("Missing or invalid firmware CRC32"));
      return false;
    }
    if (!targetPartition || targetPartition == esp_ota_get_running_partition()) {
      setFailure(F("No inactive OTA application partition is available"), 500);
      return false;
    }
    if (expectedBytes > targetPartition->size) {
      setFailure(F("Firmware is larger than the inactive OTA partition"));
      return false;
    }
    if (mbedtls_sha256_starts(&shaContext, 0) != 0) {
      setFailure(F("Could not initialize image integrity check"), 500);
      return false;
    }
    shaStarted = true;
    uploading = true;
    uploadState = UploadState::Receiving;
    lastActivityMs = millis();
    Serial.printf("Wi-Fi OTA upload started: %lu bytes into %s\n",
                  static_cast<unsigned long>(expectedBytes), targetPartition->label);
    return true;
  }

  void writeUpload(const uint8_t *data, size_t length) {
    if (!uploading || uploadState != UploadState::Receiving || length == 0) return;
    lastActivityMs = millis();
    if (receivedBytes > expectedBytes || length > expectedBytes - receivedBytes) {
      abortUpload(F("Received more bytes than declared"));
      return;
    }

    runningCrc = updateCrc32(runningCrc, data, length);
    if (!identityFound) {
      for (size_t i = 0; i < length; ++i) {
        if (data[i] == static_cast<uint8_t>(imageIdentity[identityMatchLength])) {
          ++identityMatchLength;
          if (identityMatchLength == imageIdentity.length()) {
            identityFound = true;
            break;
          }
        } else {
          identityMatchLength =
              data[i] == static_cast<uint8_t>(imageIdentity[0]) ? 1 : 0;
        }
      }
    }
    if (mbedtls_sha256_update(&shaContext, data, length) != 0) {
      abortUpload(F("SHA-256 calculation failed"));
      return;
    }
    receivedBytes += length;

    size_t offset = 0;
    if (!headerValidated) {
      const size_t toCopy =
          std::min(length, APP_PREFIX_SIZE - appPrefixLength);
      memcpy(appPrefix + appPrefixLength, data, toCopy);
      appPrefixLength += toCopy;
      offset += toCopy;
      if (appPrefixLength == APP_PREFIX_SIZE && !validateAppPrefix()) {
        abortUpload(error, false);
        return;
      }
    }
    if (headerValidated && offset < length) {
      const esp_err_t result = esp_ota_write(otaHandle, data + offset, length - offset);
      if (result != ESP_OK) {
        abortUpload(String(F("Flash write failed: ")) + esp_err_to_name(result));
      }
    }
  }

  bool clearRebootMarker() {
    Preferences preferences;
    if (!preferences.begin(preferencesNamespace.c_str(), false)) {
      return false;
    }
    const bool removed = !preferences.isKey("resume") || preferences.remove("resume");
    preferences.end();
    if (removed) resumeMarkerNeedsClear = false;
    return removed;
  }

  bool persistRebootMarker() {
    Preferences preferences;
    if (!preferences.begin(preferencesNamespace.c_str(), false)) return false;
    const bool stored =
        preferences.putString("prev_ver", firmwareVersion) == firmwareVersion.length() &&
        preferences.putString("last_sha", imageSha256) == imageSha256.length() &&
        preferences.putBool("resume", true) == 1;
    if (!stored) preferences.remove("resume");
    preferences.end();
    resumeMarkerNeedsClear = stored;
    return stored;
  }

  void finishUpload(HTTPUpload &upload) {
    if (!uploading || uploadState != UploadState::Receiving) return;
    lastActivityMs = millis();
    if (upload.totalSize != expectedBytes || receivedBytes != expectedBytes) {
      abortUpload(F("Upload was incomplete; inactive partition was not selected"));
      return;
    }
    if (!headerValidated || !otaHandleActive) {
      abortUpload(F("Application header was not validated"));
      return;
    }
    if (!identityFound) {
      abortUpload(F("Firmware belongs to a different Atech demo/target"));
      return;
    }
    const uint32_t completedCrc = runningCrc ^ 0xFFFFFFFFUL;
    if (completedCrc != expectedCrc) {
      abortUpload(F("Upload CRC32 mismatch; inactive partition was not selected"));
      return;
    }

    uint8_t digest[32] = {};
    if (mbedtls_sha256_finish(&shaContext, digest) != 0) {
      abortUpload(F("SHA-256 finalization failed"));
      return;
    }
    mbedtls_sha256_free(&shaContext);
    mbedtls_sha256_init(&shaContext);
    shaStarted = false;
    imageSha256 = sha256Hex(digest);
    uploadState = UploadState::Verifying;

    // esp_ota_end validates the ESP image checksum/appended SHA-256 and, when
    // configured on the device, secure-boot signature and anti-rollback state.
    // It does not select the image; boot selection happens only after success.
    const esp_err_t validationResult = esp_ota_end(otaHandle);
    otaHandleActive = false;
    otaHandle = 0;
    if (validationResult != ESP_OK) {
      uploading = false;
      setFailure(String(F("ESP image verification failed: ")) +
                     esp_err_to_name(validationResult),
                 422);
      return;
    }
    if (!persistRebootMarker()) {
      uploading = false;
      setFailure(F("Verified image was not selected because post-reboot status could not be persisted"), 500);
      return;
    }
    const esp_err_t activationResult = esp_ota_set_boot_partition(targetPartition);
    if (activationResult != ESP_OK) {
      clearRebootMarker();
      uploading = false;
      setFailure(String(F("Verified image could not be selected: ")) +
                     esp_err_to_name(activationResult),
                 500);
      return;
    }

    uploading = false;
    uploadState = UploadState::Verified;
    responseStatus = 200;
    error = "";
    rebootAtMs = millis() + config.rebootDelayMs;
    Serial.printf("Wi-Fi OTA verified: %lu bytes, SHA-256 %s; reboot scheduled\n",
                  static_cast<unsigned long>(receivedBytes), imageSha256.c_str());
  }

  void handleUpload() {
    HTTPUpload &upload = server->upload();
    switch (upload.status) {
      case UPLOAD_FILE_START:
        startUpload(upload);
        break;
      case UPLOAD_FILE_WRITE:
        writeUpload(upload.buf, upload.currentSize);
        break;
      case UPLOAD_FILE_END:
        finishUpload(upload);
        break;
      case UPLOAD_FILE_ABORTED:
        // WebServer can report ABORTED after the final file boundary if the
        // client vanishes before reading the HTTP response. A fully validated
        // image is already safe to boot; only an in-progress body is partial.
        if (uploading || otaHandleActive) {
          abortUpload(F("Browser disconnected; incomplete update discarded"));
        }
        break;
    }
  }

  void handleUpdateResponse() {
    if (uploadState == UploadState::Verified) {
      String json = F("{\"ok\":true,\"stage\":\"verified\",\"bytes\":");
      json += String(receivedBytes);
      json += F(",\"sha256\":\"");
      json += imageSha256;
      json += F("\",\"reboot_in_ms\":");
      json += String(config.rebootDelayMs);
      json += F("}");
      sendJson(200, json);
      return;
    }
    String json = F("{\"ok\":false,\"stage\":\"");
    json += uploadStateName();
    json += F("\",\"error\":\"");
    json += jsonEscape(error.isEmpty() ? String(F("Upload did not complete")) : error);
    json += F("\"}");
    sendJson(responseStatus, json);
  }

  void configureRoutes() {
    const char *headers[] = {
        "X-Atech-OTA-Key", "X-Atech-Firmware-Size", "X-Atech-Firmware-CRC32"};
    server->collectHeaders(headers, 3);
    server->on("/", HTTP_GET, [this]() {
      server->sendHeader(F("Cache-Control"), F("no-store"));
      server->send_P(200, PSTR("text/html; charset=utf-8"), PORTAL_HTML);
    });
    server->on("/api/status", HTTP_GET, [this]() {
      sendJson(200, statusJson());
    });
    server->on(
        "/api/update", HTTP_POST, [this]() { handleUpdateResponse(); },
        [this]() { handleUpload(); });
    server->on("/api/exit", HTTP_POST, [this]() {
      if (!authorize()) {
        sendJson(401, F("{\"ok\":false,\"error\":\"Invalid OTA authorization code\"}"));
        return;
      }
      if (uploading) {
        sendJson(409, F("{\"ok\":false,\"error\":\"Update is active\"}"));
        return;
      }
      if (rebootAtMs != 0) {
        sendJson(409, F("{\"ok\":false,\"error\":\"Verified update is rebooting\"}"));
        return;
      }
      lastActivityMs = millis();
      sendJson(200, F("{\"ok\":true}"));
      stopAtMs = millis() + 600;
    });
    server->on("/hotspot-detect.html", HTTP_GET, [this]() {
      server->sendHeader(F("Location"), F("http://192.168.4.1/"), true);
      server->send(302, F("text/plain"), "");
    });
    server->on("/generate_204", HTTP_GET, [this]() {
      server->sendHeader(F("Location"), F("http://192.168.4.1/"), true);
      server->send(302, F("text/plain"), "");
    });
    server->onNotFound([this]() {
      server->sendHeader(F("Location"), F("http://192.168.4.1/"), true);
      server->send(302, F("text/plain"), "");
    });
  }

  bool startPortal() {
    if (!initialized || active) return active;
    if (config.otherOtaBusy && config.otherOtaBusy()) {
      error = F("Wi-Fi OTA refused: disconnect Bluetooth and wait for BLE OTA to finish");
      Serial.println(error);
      return false;
    }
    if (config.modeChanged) config.modeChanged(true);
    // Close the small race between the first busy check and advertising being
    // stopped. Never proceed if a BLE client connected in that interval.
    if (config.otherOtaBusy && config.otherOtaBusy()) {
      error = F("Wi-Fi OTA refused: Bluetooth became active; disconnect and retry");
      if (config.modeChanged) config.modeChanged(false);
      Serial.println(error);
      return false;
    }

    WiFi.mode(WIFI_AP);
    if (!WiFi.softAPConfig(AP_IP, AP_IP, AP_MASK, IPAddress(192, 168, 4, 2), AP_IP) ||
        !WiFi.softAP(apSsid.c_str(), apPassword.c_str(), 1, 0, 4, false,
                     WIFI_AUTH_WPA2_PSK, WIFI_CIPHER_TYPE_CCMP)) {
      error = F("Could not start WPA2 SoftAP");
      WiFi.softAPdisconnect(true);
      WiFi.mode(WIFI_OFF);
      if (config.modeChanged) config.modeChanged(false);
      Serial.println(error);
      return false;
    }

    server = new (std::nothrow) WebServer(80);
    dns = new (std::nothrow) DNSServer();
    if (!server || !dns) {
      error = F("Could not allocate Wi-Fi portal services");
      if (server) { delete server; server = nullptr; }
      if (dns) { delete dns; dns = nullptr; }
      WiFi.softAPdisconnect(true);
      WiFi.mode(WIFI_OFF);
      if (config.modeChanged) config.modeChanged(false);
      Serial.println(error);
      return false;
    }

    configureRoutes();
    if (!dns->start(DNS_PORT, "*", AP_IP)) {
      Serial.println(F("Warning: captive DNS did not start; use http://192.168.4.1 directly"));
    }
    server->begin();
    targetPartition = esp_ota_get_next_update_partition(nullptr);
    active = true;
    error = "";
    uploadState = UploadState::Idle;
    lastActivityMs = millis();
    if (resumeMarkerNeedsClear && !clearRebootMarker()) {
      Serial.println(F("Warning: post-update portal started but its one-shot marker could not be cleared"));
    }
    printCredentials();
    Serial.printf("Wi-Fi OTA mode active for %lu seconds of inactivity\n",
                  static_cast<unsigned long>(config.inactivityTimeoutMs / 1000));
    return true;
  }

  bool stopPortal() {
    if (!active) return true;
    if (uploading) {
      error = F("Cannot exit while an update is active");
      return false;
    }
    if (rebootAtMs != 0) {
      error = F("Cannot exit while a verified update is rebooting");
      return false;
    }
    if (server) {
      server->stop();
      delete server;
      server = nullptr;
    }
    if (dns) {
      dns->stop();
      delete dns;
      dns = nullptr;
    }
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_OFF);
    active = false;
    stopAtMs = 0;
    postUpdateBoot = false;
    uploadState = UploadState::Idle;
    if (config.modeChanged) config.modeChanged(false);
    Serial.println(F("Wi-Fi OTA mode stopped; BLE mode restored"));
    return true;
  }

  void handleButton() {
    if (config.buttonPin < 0) return;
    const bool raw = digitalRead(config.buttonPin);
    const bool pressed = config.buttonActiveLow ? !raw : raw;
    if (ignoreButtonUntilRelease) {
      if (!pressed) ignoreButtonUntilRelease = false;
      return;
    }
    if (pressed && !buttonWasPressed) {
      buttonWasPressed = true;
      buttonHandled = false;
      buttonPressedMs = millis();
    } else if (!pressed) {
      buttonWasPressed = false;
      buttonHandled = false;
    } else if (!buttonHandled && millis() - buttonPressedMs >= config.buttonHoldMs) {
      buttonHandled = true;
      if (active) {
        if (!uploading && rebootAtMs == 0) stopPortal();
      } else {
        startPortal();
      }
    }
  }

  void service() {
    if (!initialized) return;
    uint32_t now = millis();
    if (rebootAtMs != 0 && static_cast<int32_t>(now - rebootAtMs) >= 0) {
      Serial.println(F("Rebooting into verified Wi-Fi OTA image"));
      Serial.flush();
      delay(50);
      ESP.restart();
    }
    handleButton();
    if (!active) return;
    if (dns) dns->processNextRequest();
    if (server) server->handleClient();

    now = millis();
    if (rebootAtMs != 0 && static_cast<int32_t>(now - rebootAtMs) >= 0) {
      Serial.println(F("Rebooting into verified Wi-Fi OTA image"));
      Serial.flush();
      delay(50);
      ESP.restart();
    }
    if (stopAtMs != 0 && static_cast<int32_t>(now - stopAtMs) >= 0) {
      stopPortal();
      return;
    }
    if (!uploading && config.inactivityTimeoutMs > 0 &&
        now - lastActivityMs >= config.inactivityTimeoutMs) {
      Serial.println(F("Wi-Fi OTA mode timed out from inactivity"));
      stopPortal();
    }
  }
};

AtechWifiOtaPortal::AtechWifiOtaPortal() : _impl(new Impl()) {}

AtechWifiOtaPortal::~AtechWifiOtaPortal() { delete _impl; }

bool AtechWifiOtaPortal::begin(const AtechWifiOtaConfig &config) {
  if (!_impl || _impl->initialized) return _impl && _impl->initialized;
  _impl->config = config;
  _impl->deviceName = config.deviceName ? config.deviceName : "Atech ESP32-S3";
  _impl->firmwareVersion = config.firmwareVersion ? config.firmwareVersion : "unknown";
  _impl->ssidPrefix = config.ssidPrefix ? config.ssidPrefix : "Atech-OTA";
  _impl->imageIdentity = config.imageIdentity ? config.imageIdentity : "";
  _impl->preferencesNamespace =
      config.preferencesNamespace ? config.preferencesNamespace : "atechota";
  if (_impl->imageIdentity.length() < 8) {
    _impl->error = F("Image identity marker must contain at least 8 characters");
    Serial.printf("Wi-Fi OTA disabled: %s\n", _impl->error.c_str());
    return false;
  }
  if (_impl->config.buttonHoldMs == 0) _impl->config.buttonHoldMs = 3000;
  if (_impl->config.inactivityTimeoutMs == 0) {
    _impl->config.inactivityTimeoutMs = 10UL * 60UL * 1000UL;
  }
  if (_impl->config.rebootDelayMs < 1000) _impl->config.rebootDelayMs = 2200;

  // The last three MAC bytes are device-unique; the first three are the
  // Espressif OUI shared by every chip from the same batch.
  uint8_t mac[6] = {};
  esp_efuse_mac_get_default(mac);
  char suffix[7];
  snprintf(suffix, sizeof(suffix), "%02X%02X%02X", mac[3], mac[4], mac[5]);
  _impl->apSsid = _impl->ssidPrefix + "-" + suffix;
  if (!_impl->loadCredentials()) {
    Serial.printf("Wi-Fi OTA disabled: %s\n", _impl->error.c_str());
    return false;
  }

  if (_impl->config.buttonPin >= 0) {
    pinMode(_impl->config.buttonPin,
            _impl->config.buttonActiveLow ? INPUT_PULLUP : INPUT_PULLDOWN);
    const bool raw = digitalRead(_impl->config.buttonPin);
    const bool pressed = _impl->config.buttonActiveLow ? !raw : raw;
    // A BOOT button held during reset is part of the ROM flashing sequence. Do
    // not turn that into a runtime OTA request; require release and a fresh hold.
    _impl->ignoreButtonUntilRelease = pressed;
  }
  _impl->initialized = true;
  _impl->printCredentials();
  if (_impl->postUpdateBoot) {
    Serial.println(F("Successful Wi-Fi update marker found; restoring portal for verification"));
    return _impl->startPortal();
  }
  return true;
}

void AtechWifiOtaPortal::loop() {
  if (_impl) _impl->service();
}

bool AtechWifiOtaPortal::start() {
  return _impl && _impl->startPortal();
}

bool AtechWifiOtaPortal::stop() {
  return _impl && _impl->stopPortal();
}

bool AtechWifiOtaPortal::isActive() const {
  return _impl && _impl->active;
}

bool AtechWifiOtaPortal::isUpdating() const {
  return _impl && _impl->uploading;
}

const String &AtechWifiOtaPortal::ssid() const {
  static const String empty;
  return _impl ? _impl->apSsid : empty;
}

const String &AtechWifiOtaPortal::lastError() const {
  static const String empty;
  return _impl ? _impl->error : empty;
}
