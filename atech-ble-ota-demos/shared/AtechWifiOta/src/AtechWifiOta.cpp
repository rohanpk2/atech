// AtechWifiOta.cpp: see AtechWifiOta.h. The page is served from PROGMEM; every mutating route and
// the upload are gated by the per-device OTA authorization code; the image goes through
// atech::ImageSink, which checks the header, the markers, the digest, the signature and the
// version policy and selects the slot only when everything passed.
#include "AtechWifiOta.h"

#include <AtechCloudOta.h>
#include <AtechCore.h>
#include <AtechFwSign.h>
#include <AtechImageSink.h>
#include <AtechWifiLan.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_err.h>
#include <esp_mac.h>
#include <esp_ota_ops.h>
#include <esp_system.h>

#include <algorithm>
#include <cerrno>
#include <cstring>

namespace {

const IPAddress AP_IP(192, 168, 4, 1);
const IPAddress AP_MASK(255, 255, 255, 0);
constexpr uint16_t DNS_PORT = 53;
constexpr size_t MIN_IMAGE_BYTES = 1024;
constexpr uint32_t CLIENT_RECENT_MS = 120000;     // a client seen this recently keeps an auto-started hotspot up
constexpr uint32_t CLOUD_CONTACT_MAX_MS = 60000;  // a cloud session with no successful exchange for this long counts as offline
constexpr uint32_t POLICY_INTERVAL_MS = 1000;
constexpr uint32_t MANUAL_SUPPRESS_MS = 600000;   // after the user closed the hotspot by hand, the policy waits
constexpr char CREDENTIAL_ALPHABET[] =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

const char PORTAL_HTML[] PROGMEM = R"ATECHHTML(
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>Atech board update</title>
  <style>
    :root{color-scheme:light;--bg:#fff;--surface:#f7f7f8;--border:#e6e6ea;--border-strong:#d3d3d9;--text:#171717;--muted:#6b6b76;--ink:#000;--working:#4f52d9;--working-soft:#eeeefc;--green:#1a9a52;--green-text:#176a3c;--green-soft:#ecf9f1;--red:#d93025;--red-text:#a3261d;--red-soft:#fdf1ef;--amber-text:#8a5410;--amber-soft:#fff7e8;--radius:12px;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
    main{width:min(680px,calc(100% - 32px));margin:0 auto;padding:28px 0 56px}
    .eyebrow{color:var(--muted);font-size:12px;letter-spacing:.06em;text-transform:uppercase;font-weight:600}
    h1{margin:4px 0 2px;font-size:24px;font-weight:600;letter-spacing:-.02em}h2{margin:0;font-size:15px;font-weight:600}
    .sub{margin:0 0 18px;color:var(--muted)}
    .card{border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);padding:18px 20px;margin-top:14px}
    .head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
    .badge{display:inline-block;padding:2px 9px;border:1px solid var(--border);border-radius:999px;font-size:12px;color:var(--muted);background:var(--surface);white-space:nowrap}
    .badge.ok{color:var(--green-text);border-color:#bfe8cf;background:var(--green-soft)}.badge.bad{color:var(--red-text);border-color:#f5c6c0;background:var(--red-soft)}.badge.work{color:var(--working);border-color:#c9caf4;background:var(--working-soft)}
    .state{margin:8px 0 0;color:var(--muted)}.state.ok{color:var(--green-text)}.state.bad{color:var(--red-text)}.state.work{color:var(--working)}
    label{display:block;margin:12px 0 5px;font-size:12px;color:var(--muted);font-weight:500}
    input,select{width:100%;padding:9px 11px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg);font:inherit;color:inherit}
    input[type=file]{padding:7px}
    .row{display:flex;gap:8px;align-items:flex-end}.row>*{flex:1}.row>button{flex:0 0 auto}
    button{padding:9px 14px;border:1px solid var(--ink);border-radius:8px;background:var(--ink);color:#fff;font:inherit;font-weight:500;cursor:pointer}
    button.secondary{background:var(--bg);color:var(--text);border-color:var(--border-strong)}button.text{background:none;border-color:transparent;color:var(--muted);padding-left:0}
    button:disabled{opacity:.45;cursor:not-allowed}
    .actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
    .actions a.secondary{display:inline-block;text-decoration:none;padding:9px 14px;border:1px solid var(--border-strong);border-radius:8px;color:var(--text);background:var(--bg)}
    .bar{height:6px;border-radius:999px;background:var(--surface);overflow:hidden;margin-top:12px}.bar>span{display:block;height:100%;width:0;background:var(--working);transition:width .15s}
    .bar.ok>span{background:var(--green)}.bar.bad>span{background:var(--red)}
    .meta{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:6px;color:var(--muted);font-size:12px}
    .facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 18px;margin:0}
    .facts dt{font-size:12px;color:var(--muted)}.facts dd{margin:2px 0 0;font-weight:500;overflow-wrap:anywhere}
    .mono{font-family:var(--mono);font-size:12px}
    .hint{margin:8px 0 0;color:var(--muted);font-size:12px}
    noscript{color:var(--red-text)}
    @media(max-width:520px){.facts{grid-template-columns:1fr}.row{flex-direction:column;align-items:stretch}}
  </style>
</head>
<body><main>
  <div class="eyebrow">Atech local update</div>
  <h1 id="device">Atech board</h1>
  <p class="sub" id="summary">Checking the board.</p>
  <noscript>JavaScript is required to upload firmware and show progress.</noscript>

  <section class="card" aria-labelledby="update-title">
    <div class="head"><h2 id="update-title">Update firmware</h2><span id="updateBadge" class="badge">Ready</span></div>
    <p class="hint">Choose the signed update package (<span class="mono">.atech</span>) you downloaded from the Atech dashboard, enter the board's authorization code, and deploy. The board checks the signature and the complete image before anything is activated.</p>
    <label for="firmware">Update package</label>
    <input id="firmware" type="file" accept=".atech,.bin,application/octet-stream">
    <div id="fileInfo" class="meta"></div>
    <label for="token">Authorization code</label>
    <input id="token" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Shown in the dashboard next to the hotspot password">
    <div id="progressBar" class="bar" role="progressbar" aria-label="Firmware upload" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="bar"></span></div>
    <div id="progress" class="meta">No file selected.</div>
    <p id="result" class="state" role="status" aria-live="polite">Keep the board powered until the update is verified.</p>
    <div id="postBoot" class="state" role="status" aria-live="polite" hidden></div>
    <div class="actions">
      <button id="deploy" disabled>Deploy Firmware</button>
      <button id="exit" class="secondary">Close the hotspot</button>
    </div>
    <p class="hint">Upload progress only confirms browser-to-board transfer. Success is shown only after the board verifies the signature and the complete image and selects the inactive partition.</p>
  </section>

  <section class="card" id="wifiCard" aria-labelledby="wifi-title" hidden>
    <div class="head"><h2 id="wifi-title">Wi-Fi network</h2><span id="wifiBadge" class="badge">Checking</span></div>
    <p id="wifiStatus" class="state" role="status" aria-live="polite">Checking.</p>
    <label for="wifiSsid">Network name (2.4 GHz)</label>
    <div class="row">
      <input id="wifiSsid" list="wifiList" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Choose or type a network">
      <button id="wifiScan" class="secondary">Scan</button>
    </div>
    <datalist id="wifiList"></datalist>
    <label for="wifiAuth">Security</label>
    <select id="wifiAuth">
      <option value="personal">Personal network (WPA2 or WPA3 password)</option>
      <option value="peap">Enterprise: PEAP (username and password)</option>
      <option value="ttls">Enterprise: EAP-TTLS (username and password)</option>
      <option value="tls">Enterprise: EAP-TLS (client certificate)</option>
    </select>
    <div id="wifiEnterprise" hidden>
      <label for="wifiUser">Username</label>
      <input id="wifiUser" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Username">
      <label for="wifiIdentity">Anonymous identity (optional; the identity for EAP-TLS)</label>
      <input id="wifiIdentity" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="anonymous@example.edu">
      <label for="wifiPhase2">TTLS phase 2</label>
      <select id="wifiPhase2"><option value="mschapv2">MSCHAPv2</option><option value="eap">EAP</option><option value="mschap">MSCHAP</option><option value="pap">PAP</option><option value="chap">CHAP</option></select>
      <label for="wifiDomain">Server name to match (optional)</label>
      <input id="wifiDomain" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="radius.example.edu">
      <label class="row" style="align-items:center;margin-top:12px"><input id="wifiCaBundle" type="checkbox" style="width:auto;flex:0 0 auto"> <span>Trust the built-in certificate bundle (public CAs) instead of a CA file</span></label>
      <label for="wifiCa">CA certificate (PEM)</label>
      <input id="wifiCa" type="file" accept=".pem,.crt,.cer,.txt">
      <div id="wifiCertRow">
        <label for="wifiCert">Client certificate (PEM)</label>
        <input id="wifiCert" type="file" accept=".pem,.crt,.cer">
        <label for="wifiKey">Client private key (PEM)</label>
        <input id="wifiKey" type="file" accept=".pem,.key">
      </div>
      <p class="hint">The board checks the authentication server's certificate against the CA or the bundle; certificate checking is never disabled.</p>
    </div>
    <label for="wifiPass">Wi-Fi password</label>
    <input id="wifiPass" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Leave empty for an open network">
    <div class="actions">
      <button id="wifiSave">Join this network</button>
      <button id="wifiForget" class="text">Forget this network</button>
    </div>
    <p class="hint">Once the board is on a network with internet access it updates itself from the Atech dashboard. This hotspot stays available when it cannot.</p>
  </section>

  <section class="card" id="netCard" aria-labelledby="net-title" hidden>
    <div class="head"><h2 id="net-title">Internet access</h2><span id="netBadge" class="badge">Checking</span></div>
    <p id="netStatus" class="state" role="status" aria-live="polite">Checking whether the network reaches the internet.</p>
    <dl class="facts"><div><dt>Board MAC address (for IT device registration)</dt><dd id="netMac" class="mono">Checking</dd></div></dl>
    <div class="actions">
      <button id="netHelper" class="secondary" hidden>Sign in through this board</button>
      <a id="netSignIn" class="secondary" href="http://neverssl.com/" target="_blank" rel="noreferrer" hidden>Open the network's sign-in page</a>
      <button id="netRecheck" class="text">Check again</button>
    </div>
    <p id="netHint" class="hint">If this network shows a sign-in page, the board cannot reach the Atech build service. Sign in through the board (your browser's traffic goes through it, so the network authorizes the board), ask IT to register the MAC address above, or use the local update on this page.</p>
  </section>

  <section class="card" id="cloudCard" aria-labelledby="cloud-title" hidden>
    <div class="head"><h2 id="cloud-title">Cloud deployments</h2><span id="cloudBadge" class="badge">Checking</span></div>
    <p id="cloudStatus" class="state" role="status" aria-live="polite">Checking.</p>
    <label for="cloudUrl">Build service URL (https)</label>
    <div class="row">
      <input id="cloudUrl" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="https://atech-api.example.com">
      <button id="cloudSave" class="secondary">Save</button>
    </div>
    <div class="actions"><button id="cloudClear" class="text">Use the built-in default</button></div>
    <p class="hint">The board polls this server over HTTPS for firmware deployed from the dashboard. Your Wi-Fi password never leaves the board.</p>
  </section>

  <section class="card" aria-labelledby="board-title">
    <div class="head"><h2 id="board-title">Board</h2><span id="signBadge" class="badge">Checking</span></div>
    <dl class="facts">
      <div><dt>Device ID</dt><dd id="deviceId" class="mono">Checking</dd></div>
      <div><dt>Firmware</dt><dd id="version">Checking</dd></div>
      <div><dt>Hotspot</dt><dd id="ssid" class="mono">Checking</dd></div>
      <div><dt>Address</dt><dd id="hostname" class="mono">Checking</dd></div>
      <div><dt>Signing key</dt><dd id="signKey" class="mono">Checking</dd></div>
      <div><dt>Portal</dt><dd id="connection" role="status" aria-live="polite">Connecting</dd></div>
    </dl>
    <label for="signInput">Trusted signing key (130 hex characters, from the dashboard's build service)</label>
    <div class="row"><input id="signInput" class="mono" type="text" autocomplete="off" spellcheck="false" placeholder="04..."><button id="signSave" class="secondary">Save key</button></div>
    <p id="signHint" class="hint">The board trusts firmware signed by this key. It is set automatically the first time the board talks to the build service; set it here only for a board that never had internet access.</p>
  </section>
</main>
<script>
(() => {
  const $ = id => document.getElementById(id);
  const fileInput=$('firmware'), tokenInput=$('token'), deploy=$('deploy'), exitButton=$('exit'), result=$('result'), bar=$('bar'), progress=$('progress'), progressBar=$('progressBar'), updateBadge=$('updateBadge');
  let selected=null, pkg=null, portalStatus=null, portalBusy=false, refreshInFlight=false, fileGeneration=0, wifiSaving=false, signArmed=false;
  const MAGIC='ATECHPKG1\n', HEADER_LEN=14, HEX=/^[0-9a-f]+$/i;
  const setResult=(text,kind='')=>{result.textContent=text;result.className='state '+kind};
  const setBadge=(el,text,kind='')=>{el.textContent=text;el.className='badge '+kind};
  const setProgress=(pct,kind='')=>{const v=Math.max(0,Math.min(100,pct));bar.style.width=v+'%';progressBar.className='bar '+kind;progressBar.setAttribute('aria-valuenow',String(v))};
  const fmt=n=>n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KiB':(n/1048576).toFixed(2)+' MiB';
  function needToken(where){const t=tokenInput.value.trim();if(!t){where('Enter the authorization code first (the dashboard shows it next to the hotspot password).','bad');tokenInput.focus()}return t}
  async function refresh(){if(refreshInFlight)return portalStatus;refreshInFlight=true;try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);const s=await r.json();portalStatus=s;$('device').textContent=s.device;$('deviceId').textContent=s.device_id;$('version').textContent=s.version;$('ssid').textContent=s.ssid;$('hostname').textContent=`http://${s.hostname}.local or http://${s.ip}`;$('summary').textContent=`Demo ${s.demo} board on its own hotspot. ${s.clients} device${s.clients===1?'':'s'} connected.`;$('connection').textContent=`Online, ${s.clients} client${s.clients===1?'':'s'}`;if(s.sign){$('signKey').textContent=s.sign.key?`${s.sign.kid} (${s.sign.source})`:'None yet';setBadge($('signBadge'),s.sign.key?'Signed updates only':s.sign.unsigned_ok?'Lab build: unsigned accepted':'No key yet',s.sign.key?'ok':'')}renderNet(s);if(s.post_update_boot){const p=$('postBoot');p.hidden=false;p.className='state ok';p.textContent=s.previous_version&&s.previous_version!==s.version?`Post-update boot verified: ${s.previous_version} is now ${s.version}.`:`Post-update boot verified. Running firmware reports ${s.version}; confirm the intended version.`}else if(s.ota_state==='failed'&&s.error&&!portalBusy){setResult(`Previous update failed: ${s.error}`,'bad')}return s}catch(e){$('connection').textContent='Reconnecting';throw e}finally{refreshInFlight=false}}
  function renderNet(s){if(s.mac)$('netMac').textContent=s.mac;const helper=Boolean(s.helper);const net=s.internet||'unknown';let text,badge='Checking',kind='';if(net==='ok'){text='The network reaches the internet; the board updates itself from the Atech dashboard.';badge='Online';kind='ok'}else if(net==='captive'){text=helper?'Sign-in helper is on. If your device joined this hotspot before the helper started, reconnect to it, then open the sign-in page: your browser goes through the board, so the network authorizes the board. The helper turns itself off once the board reaches the internet.':'This network shows a sign-in page before it allows internet access, so the board cannot reach the build service. Sign in through this board, ask IT to register the MAC address above, or use the local update.';badge='Sign-in needed';kind='bad'}else if(net==='offline'){text='The board is on the network but nothing answers from the internet. Check the network, or use the local update on this page.';badge='No internet';kind='bad'}else if(net==='checking'){text='Checking whether the network reaches the internet.'}else{text='Not on a network yet.'}$('netStatus').textContent=text;$('netStatus').className='state '+kind;setBadge($('netBadge'),badge,kind);$('netHelper').hidden=!(net==='captive'&&!helper);$('netSignIn').hidden=!helper;if(s.captive_url)$('netSignIn').href=s.captive_url}
  function latin(u8){let t='';for(const b of u8)t+=String.fromCharCode(b);return t}
  async function readPackage(file){if(file.size<HEADER_LEN+2)return null;const head=new Uint8Array(await file.slice(0,14).arrayBuffer());if(latin(head.subarray(0,10))!==MAGIC)return null;const len=new DataView(head.buffer,head.byteOffset,head.byteLength).getUint32(10,true);if(len===0||len>65536||HEADER_LEN+len>file.size)throw new Error('The update package header is damaged; download it again.');let header;try{header=JSON.parse(new TextDecoder().decode(await file.slice(HEADER_LEN,HEADER_LEN+len).arrayBuffer()))}catch(e){throw new Error('The update package header is not readable; download it again.')}const offset=HEADER_LEN+len;if(!header||header.v!==1||!Number.isInteger(header.size)||typeof header.build!=='string')throw new Error('The update package header is incomplete.');if(file.size-offset!==header.size)throw new Error(`The update package body is ${fmt(file.size-offset)} but its header says ${fmt(header.size)}; download it again.`);if(!HEX.test(header.sha256||'')||header.sha256.length!==64||!HEX.test(header.sig||'')||header.sig.length!==128||!HEX.test(header.pub||'')||header.pub.length!==130)throw new Error('The update package is not signed correctly; download it again from the dashboard.');return {header,offset}}
  async function preflight(file,offset){if(file.size-offset<1024)throw new Error('The file is too small to be an ESP application image.');const b=new Uint8Array(await file.slice(offset,offset+36).arrayBuffer());const v=new DataView(b.buffer,b.byteOffset,b.byteLength);if(b[0]!==0xe9)throw new Error('This file is not an ESP application image.');if(v.getUint16(12,true)!==9)throw new Error('The firmware target is not ESP32-S3.');if((b[3]>>4)!==4)throw new Error('The firmware target is not the configured 16 MB board.');if(v.getUint32(32,true)!==0xabcd5432)throw new Error('Choose the update package or an application firmware.bin, not a bootloader or merged image.');if(portalStatus&&portalStatus.partition_capacity&&file.size-offset>portalStatus.partition_capacity)throw new Error(`The image exceeds this board's ${fmt(portalStatus.partition_capacity)} OTA slot.`)}
  fileInput.addEventListener('change',async()=>{const generation=++fileGeneration;const candidate=fileInput.files[0]||null;selected=null;pkg=null;deploy.disabled=true;setProgress(0);$('fileInfo').textContent='';if(!candidate){portalBusy=false;progress.textContent='No file selected.';return}portalBusy=true;progress.textContent=`Checking ${candidate.name} (${fmt(candidate.size)})`;try{const name=candidate.name.toLowerCase();if(!name.endsWith('.atech')&&!name.endsWith('.bin'))throw new Error('Choose the .atech update package from the dashboard (or an application firmware.bin).');const parsed=await readPackage(candidate);if(!parsed&&name.endsWith('.atech'))throw new Error('This is not an Atech update package.');await preflight(candidate,parsed?parsed.offset:0);if(generation!==fileGeneration)return;if(parsed){const h=parsed.header;if(portalStatus&&portalStatus.demo&&Number(h.demo)!==Number(portalStatus.demo))throw new Error(`This package is for Demo ${h.demo}; this board runs Demo ${portalStatus.demo}.`);if(h.target&&portalStatus&&portalStatus.device_id&&h.target!==portalStatus.device_id)throw new Error(`This package was signed for ${h.target}, not for this board (${portalStatus.device_id}).`);$('fileInfo').textContent=`Signed update package: ${h.app||'app'} v${h.ver} (build ${h.build}, ${fmt(h.size)}, key ${h.kid})${h.downgrade?', downgrade allowed':''}`;progress.textContent='Ready to deploy.'}else{$('fileInfo').textContent='Unsigned firmware.bin: a board that trusts a signing key refuses it.';progress.textContent=`Ready: ${fmt(candidate.size)}`}selected=candidate;pkg=parsed;deploy.disabled=false;setResult('File checked locally. Click Deploy Firmware.')}catch(e){if(generation!==fileGeneration)return;selected=null;pkg=null;setResult(e.message,'bad');progress.textContent='File rejected before upload.'}finally{if(generation===fileGeneration)portalBusy=false}});
  deploy.addEventListener('click',()=>{if(!selected)return;const token=needToken(setResult);if(!token)return;portalBusy=true;deploy.disabled=true;exitButton.disabled=true;fileInput.disabled=true;tokenInput.disabled=true;setProgress(0,'work');setBadge(updateBadge,'Uploading','work');setResult('Uploading to the inactive OTA partition.','work');const offset=pkg?pkg.offset:0;const image=selected.slice(offset);const body=new FormData();body.append('firmware',image,'firmware.bin');const xhr=new XMLHttpRequest();xhr.open('POST','/api/update');xhr.responseType='json';xhr.timeout=600000;xhr.setRequestHeader('X-Atech-OTA-Key',token);xhr.setRequestHeader('X-Atech-Firmware-Size',String(image.size));if(pkg){const h=pkg.header;xhr.setRequestHeader('X-Atech-Build',h.build);xhr.setRequestHeader('X-Atech-Demo',String(h.demo));xhr.setRequestHeader('X-Atech-Version',String(h.ver));xhr.setRequestHeader('X-Atech-Downgrade',h.downgrade?'1':'0');xhr.setRequestHeader('X-Atech-Target',h.target||'');xhr.setRequestHeader('X-Atech-SHA256',h.sha256);xhr.setRequestHeader('X-Atech-Sig',h.sig);xhr.setRequestHeader('X-Atech-Key',h.pub)}xhr.upload.onprogress=e=>{if(e.lengthComputable){const pct=Math.min(100,Math.round(e.loaded*100/e.total));setProgress(pct,'work');progress.textContent=`Uploading ${pct}%: ${fmt(e.loaded)} of ${fmt(e.total)}`;if(pct===100)setResult('Browser upload complete; waiting for device receipt and flash verification. Do not reset.','work')}};xhr.onerror=()=>done('Connection lost. The incomplete image was not selected; rejoin the hotspot and retry.','bad');xhr.ontimeout=()=>done('Upload timed out. Rejoin the hotspot; the board discards the incomplete image.','bad');xhr.onabort=()=>done('Upload cancelled. The incomplete image was discarded.','bad');xhr.onload=()=>{const data=xhr.response||{};if(xhr.status===200&&data.ok){setProgress(100,'ok');setBadge(updateBadge,'Verified','ok');setResult(`Flash verified (${fmt(data.bytes)}; SHA-256 ${String(data.sha256).slice(0,16)}). Rebooting into the new firmware.`,'ok');progress.textContent='Transfer complete; the board verified the signature and the image.';waitForReboot()}else done(data.error||`Update failed (HTTP ${xhr.status}).`,'bad')};xhr.send(body)});
  function done(message,kind){portalBusy=false;setResult(message,kind);setBadge(updateBadge,kind==='bad'?'Failed':'Ready',kind);if(kind==='bad')setProgress(0,'bad');deploy.disabled=!selected;exitButton.disabled=false;fileInput.disabled=false;tokenInput.disabled=false}
  async function waitForReboot(){let attempts=0;const poll=async()=>{attempts++;try{const s=await refresh();if(s.post_update_boot){done(`New firmware is online: ${s.version}. You can switch back to your normal Wi-Fi now.`,'ok');return}}catch(e){}if(attempts<45)setTimeout(poll,2000);else done('The board rebooted, but this browser could not reconnect. Rejoin the same hotspot and reopen this page to verify.','bad')};setTimeout(poll,3500)}
  exitButton.addEventListener('click',async()=>{const token=needToken(setResult);if(!token)return;try{const r=await fetch('/api/exit',{method:'POST',headers:{'X-Atech-OTA-Key':token}});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request rejected');setResult('The hotspot is closing. Reconnect to your normal Wi-Fi.','ok')}catch(e){setResult('Could not close the hotspot: '+e.message,'bad')}});
  const wifiCard=$('wifiCard'),wifiStatus=$('wifiStatus'),wifiSsid=$('wifiSsid'),wifiPass=$('wifiPass'),wifiList=$('wifiList'),wifiScan=$('wifiScan'),wifiSave=$('wifiSave'),wifiForget=$('wifiForget'),wifiAuth=$('wifiAuth');
  let wifiNetworks=[];
  const setWifi=(text,kind='')=>{wifiStatus.textContent=text;wifiStatus.className='state '+kind};
  function renderWifiForm(){const a=wifiAuth.value;$('wifiEnterprise').hidden=a==='personal';$('wifiPhase2').hidden=a!=='ttls';$('wifiCertRow').hidden=a!=='tls';$('wifiUser').hidden=a==='tls';wifiPass.hidden=a==='tls';wifiPass.placeholder=a==='personal'?'Leave empty for an open network':'Account password'}
  wifiAuth.addEventListener('change',renderWifiForm);
  wifiSsid.addEventListener('input',()=>{const n=wifiNetworks.find(x=>x.ssid===wifiSsid.value.trim());if(!n)return;if(n.enterprise&&wifiAuth.value==='personal')wifiAuth.value='peap';else if(!n.enterprise&&wifiAuth.value!=='personal')wifiAuth.value='personal';renderWifiForm()});
  async function pem(id){const f=$(id).files&&$(id).files[0];if(!f)return '';const t=await f.text();if(!/^-----BEGIN /m.test(t))throw new Error(f.name+' is not a PEM file');return t}
  async function wifiBody(ssid){const a=wifiAuth.value;const body=new URLSearchParams({ssid,auth:a,pass:wifiPass.value});if(a==='personal')return body;body.set('ident',$('wifiIdentity').value.trim());body.set('user',$('wifiUser').value.trim());body.set('domain',$('wifiDomain').value.trim());body.set('ca_bundle',$('wifiCaBundle').checked?'1':'0');if(a==='ttls')body.set('ph2',$('wifiPhase2').value);if((a==='peap'||a==='ttls')&&!$('wifiUser').value.trim())throw new Error('Enter the username (PEAP and TTLS need a username and password).');const ca=await pem('wifiCa');if(!ca&&!$('wifiCaBundle').checked)throw new Error('Choose the CA certificate (PEM) or trust the built-in bundle; the board never skips certificate checking.');body.set('ca',ca);if(a==='tls'){body.set('crt',await pem('wifiCert'));body.set('key',await pem('wifiKey'));body.set('pass','')}return body}
  async function wifiRefresh(){try{const r=await fetch('/api/wifi/status',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);const w=await r.json();wifiCard.hidden=false;$('netCard').hidden=!w.enabled;wifiForget.hidden=!w.enabled;if(!w.enabled){setWifi('Not on a network yet. Choose a 2.4 GHz network below.');setBadge($('wifiBadge'),'Not set up')}else if(w.connected){setWifi(`Connected to ${w.ssid} as ${w.ip} (${w.auth==='personal'?'personal network':'enterprise, '+String(w.auth).toUpperCase()}, signal ${w.rssi} dBm).`,'ok');setBadge($('wifiBadge'),'Connected','ok')}else{setWifi(`Set up for ${w.configured_ssid}; not connected yet${w.last_disconnect_reason?` (reason ${w.last_disconnect_reason})`:''}. Check the password and that the network is 2.4 GHz.`,'bad');setBadge($('wifiBadge'),'Not connected','bad')}return w}catch(e){wifiCard.hidden=true;return null}}
  wifiScan.addEventListener('click',async()=>{const token=needToken(setWifi);if(!token)return;wifiScan.disabled=true;setWifi('Scanning for 2.4 GHz networks.');try{const r=await fetch('/api/wifi/scan',{headers:{'X-Atech-OTA-Key':token},cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.error||'Scan failed');wifiNetworks=d.networks||[];wifiList.replaceChildren();for(const n of wifiNetworks){const o=document.createElement('option');o.value=n.ssid;o.label=`${n.ssid} (${n.rssi} dBm${n.open?', open':''}${n.enterprise?', enterprise':''})`;wifiList.append(o)}setWifi(`${(d.networks||[]).length} network(s) found; pick one from the list.`)}catch(e){setWifi('Scan failed: '+e.message,'bad')}finally{wifiScan.disabled=false}});
  wifiSave.addEventListener('click',async()=>{const token=needToken(setWifi);if(!token)return;const ssid=wifiSsid.value.trim();if(!ssid){setWifi('Enter the network name.','bad');return}wifiSaving=true;wifiSave.disabled=true;setWifi('Saving and joining '+ssid+'.','work');try{const body=await wifiBody(ssid);const r=await fetch('/api/wifi/save',{method:'POST',headers:{'X-Atech-OTA-Key':token,'Content-Type':'application/x-www-form-urlencoded'},body});const d=await r.json();if(!r.ok)throw new Error(d.error||'Save failed');wifiPass.value='';let tries=0;const poll=async()=>{tries++;const w=await wifiRefresh();if(w&&w.connected){wifiSaving=false;wifiSave.disabled=false;return}if(tries<15)setTimeout(poll,2000);else{wifiSaving=false;wifiSave.disabled=false;setWifi('The board has not joined '+ssid+' yet. It keeps retrying; check the password or try again.','bad')}};setTimeout(poll,2500)}catch(e){wifiSaving=false;wifiSave.disabled=false;setWifi('Could not save: '+e.message,'bad')}});
  wifiForget.addEventListener('click',async()=>{const token=needToken(setWifi);if(!token)return;try{const r=await fetch('/api/wifi/forget',{method:'POST',headers:{'X-Atech-OTA-Key':token}});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request rejected');await wifiRefresh()}catch(e){setWifi('Could not forget: '+e.message,'bad')}});
  const cloudCard=$('cloudCard'),cloudStatus=$('cloudStatus'),cloudUrl=$('cloudUrl'),cloudSave=$('cloudSave'),cloudClear=$('cloudClear');
  const setCloud=(text,kind='')=>{cloudStatus.textContent=text;cloudStatus.className='state '+kind};
  const stateText={disabled:'No server URL configured.',waiting_wifi:'Waiting for the Wi-Fi connection.',captive:'The network needs a sign-in before the board can reach the internet.',unclaimed:'Online, waiting to be claimed in the dashboard.',idle:'Registered; polling for deployments.',downloading:'Downloading a deployment.',installing:'Installing a deployment.',rebooting:'Rebooting into a new deployment.',confirming:'Confirming the new firmware.',error:'Error'};
  async function cloudRefresh(){try{const r=await fetch('/api/cloud/status',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);const c=await r.json();cloudCard.hidden=false;cloudClear.hidden=!c.stored_url;if(!cloudUrl.value&&c.url)cloudUrl.placeholder=c.url;let text=(stateText[c.state]||c.state)+(c.url?' Server: '+c.url+(c.stored_url?' (set here)':' (built in)')+'.':'');if(c.last_error&&c.state==='error')text+=' '+c.last_error+'.';if(c.last_contact_ms>0&&c.state!=='disabled')text+=' Last contact '+Math.round(c.last_contact_ms/1000)+' s ago.';const good=c.state==='idle'||c.state==='downloading'||c.state==='installing';setCloud(text,c.state==='error'?'bad':good?'ok':'');setBadge($('cloudBadge'),good?'Online':c.state==='disabled'?'Not set up':c.state==='error'?'Error':'Offline',good?'ok':c.state==='error'?'bad':'');return c}catch(e){cloudCard.hidden=true;return null}}
  cloudSave.addEventListener('click',async()=>{const token=needToken(setCloud);if(!token)return;const url=cloudUrl.value.trim();if(!url){setCloud('Enter the server URL, for example https://atech-api.example.com.','bad');return}cloudSave.disabled=true;try{const body=new URLSearchParams({url});const r=await fetch('/api/cloud/save',{method:'POST',headers:{'X-Atech-OTA-Key':token,'Content-Type':'application/x-www-form-urlencoded'},body});const d=await r.json();if(!r.ok)throw new Error(d.error||'Save failed');cloudUrl.value='';setCloud('Server URL saved; the board connects to it over Wi-Fi.','ok');setTimeout(cloudRefresh,3000)}catch(e){setCloud('Could not save: '+e.message,'bad')}finally{cloudSave.disabled=false}});
  cloudClear.addEventListener('click',async()=>{const token=needToken(setCloud);if(!token)return;try{const r=await fetch('/api/cloud/clear',{method:'POST',headers:{'X-Atech-OTA-Key':token}});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request rejected');await cloudRefresh()}catch(e){setCloud('Could not clear: '+e.message,'bad')}});
  const setNet=(text,kind='')=>{$('netHint').textContent=text;$('netHint').className='hint '+kind};
  $('netHelper').addEventListener('click',async()=>{const token=needToken(setNet);if(!token)return;$('netHelper').disabled=true;try{const r=await fetch('/api/net/helper',{method:'POST',headers:{'X-Atech-OTA-Key':token,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({on:'1'})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request rejected');setNet('Sign-in helper is on. Reconnect to this hotspot if your device joined it before, then open the sign-in page.','ok');refresh().catch(()=>{})}catch(e){setNet('Could not start the sign-in helper: '+e.message,'bad')}finally{$('netHelper').disabled=false}});
  $('netRecheck').addEventListener('click',async()=>{const token=needToken(setNet);if(!token)return;try{const r=await fetch('/api/net/recheck',{method:'POST',headers:{'X-Atech-OTA-Key':token}});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request rejected');setNet('Checking again; this takes a few seconds.');setTimeout(()=>refresh().catch(()=>{}),4000)}catch(e){setNet('Could not check: '+e.message,'bad')}});
  const setSign=(text,kind='')=>{$('signHint').textContent=text;$('signHint').className='hint '+kind};
  $('signSave').addEventListener('click',async()=>{const token=needToken(setSign);if(!token)return;const key=$('signInput').value.trim().toLowerCase();if(!/^04[0-9a-f]{128}$/.test(key)){setSign('The key is 130 hex characters starting with 04 (copy it from the dashboard).','bad');return}const hasKey=portalStatus&&portalStatus.sign&&portalStatus.sign.key;if(hasKey&&!signArmed){signArmed=true;setSign('This board already trusts a signing key. Click Save key again to replace it.','bad');setTimeout(()=>{signArmed=false},8000);return}signArmed=false;try{const body=new URLSearchParams({pubkey:key,replace:hasKey?'1':'0'});const r=await fetch('/api/sign/save',{method:'POST',headers:{'X-Atech-OTA-Key':token,'Content-Type':'application/x-www-form-urlencoded'},body});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request rejected');$('signInput').value='';setSign('Signing key saved. Only firmware signed with it is accepted now.','ok');refresh().catch(()=>{})}catch(e){setSign('Could not save the key: '+e.message,'bad')}});
  refresh().catch(()=>{});wifiRefresh();cloudRefresh();setInterval(()=>{if(!portalBusy)refresh().catch(()=>{});if(!wifiSaving)wifiRefresh();cloudRefresh()},5000);
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

// application/x-www-form-urlencoded value (the alphabet builder/lib/cloud-auth.js parseForm accepts).
String formEncode(const String &text) {
  static constexpr char HEX_DIGITS[] = "0123456789abcdef";
  String out;
  out.reserve(text.length() + 8);
  for (size_t i = 0; i < text.length(); ++i) {
    const char c = text[i];
    if (isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_' || c == '.' || c == '~') out += c;
    else { out += '%'; out += HEX_DIGITS[static_cast<uint8_t>(c) >> 4]; out += HEX_DIGITS[static_cast<uint8_t>(c) & 0x0f]; }
  }
  return out;
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

bool parseUnsigned(const String &text, uint32_t &value, int base = 10) {
  if (text.isEmpty() || text.length() > 10) return false;
  char *end = nullptr;
  errno = 0;
  const unsigned long parsed = strtoul(text.c_str(), &end, base);
  if (errno != 0 || end == text.c_str() || *end != '\0' || parsed > UINT32_MAX) {
    return false;
  }
  value = static_cast<uint32_t>(parsed);
  return true;
}

bool isHex(const String &text, size_t expectedLength) {
  if (text.length() != expectedLength) return false;
  for (size_t i = 0; i < text.length(); ++i) {
    const char c = text[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false;
  }
  return true;
}

bool validBuildId(const String &build) {
  if (build.length() > 40) return false;
  for (size_t i = 0; i < build.length(); ++i) {
    const char c = build[i];
    if (!(isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_')) return false;
  }
  return true;
}

}  // namespace

struct AtechWifiOtaPortal::Impl {
  enum class UploadState { Idle, Receiving, Verifying, Verified, Failed };

  AtechWifiOtaConfig config = {};
  String deviceName;
  String firmwareVersion;
  String ssidPrefix;
  String hostnamePrefix;
  String imageIdentity;
  String preferencesNamespace;
  String apPassword;
  String otaToken;
  String apSsid;
  String hostnameText;
  String error;
  String imageSha256;
  String previousVersion;
  WebServer *server = nullptr;
  DNSServer *dns = nullptr;
  atech::ImageSink sink;
  bool initialized = false;
  bool active = false;
  bool uploading = false;
  bool manifestPresent = false;
  // Sign-in helper: the user's browser is routed through the board (NAT on the hotspot, upstream DNS for
  // new leases) so the network's sign-in page authorizes the board's station.
  bool helperActive = false;
  uint32_t helperStartedMs = 0;
  uint32_t helperRecheckMs = 0;
  // Transport controller state.
  bool autoStarted = false;
  bool manualStart = false;
  uint32_t cloudLostMs = 0;
  uint32_t cloudBackMs = 0;
  uint32_t lastClientMs = 0;
  uint32_t lastPolicyMs = 0;
  uint32_t manualStopMs = 0;
  const char *reason = "offline";
  bool postUpdateBoot = false;
  bool resumeMarkerNeedsClear = false;
  String pendingKey;    // X-Atech-Key of the running upload
  bool buttonWasPressed = false;
  bool buttonHandled = false;
  bool ignoreButtonUntilRelease = false;
  uint32_t expectedBytes = 0;
  uint32_t receivedBytes = 0;
  uint32_t lastActivityMs = 0;
  uint32_t buttonPressedMs = 0;
  uint32_t rebootAtMs = 0;
  uint32_t stopAtMs = 0;
  int responseStatus = 200;
  UploadState uploadState = UploadState::Idle;

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
    Serial.println(F("Hotspot credentials (the owner's dashboard shows them too):"));
    Serial.printf("  SSID: %s\n", apSsid.c_str());
    Serial.printf("  WPA2 password: %s\n", apPassword.c_str());
    Serial.printf("  OTA authorization code: %s\n", otaToken.c_str());
    Serial.printf("  Page: http://192.168.4.1 or http://%s.local\n", hostnameText.c_str());
  }

  bool authorize() {
    if (!server) return false;
    return constantTimeEquals(server->header("X-Atech-OTA-Key"), otaToken);
  }

  // Home Wi-Fi provisioning. Every mutating route and the scan require the
  // per-device OTA authorization code; status reveals only the join result.
  void configureWifiRoutes() {
    AtechWifiLan *lan = config.lan;
    if (!lan) return;
    server->on("/api/wifi/status", HTTP_GET, [this, lan]() {
      sendJson(200, lan->statusJson());
    });
    server->on("/api/wifi/scan", HTTP_GET, [this, lan]() {
      if (!authorize()) { sendJson(401, F("{\"ok\":false,\"error\":\"Invalid OTA authorization code\"}")); return; }
      if (uploading) { sendJson(409, F("{\"ok\":false,\"error\":\"Update is active\"}")); return; }
      lastActivityMs = millis();
      String body = F("{\"ok\":true,\"networks\":");
      body += lan->scanJson();
      body += F("}");
      sendJson(200, body);
    });
    server->on("/api/wifi/save", HTTP_POST, [this, lan]() {
      if (!authorize()) { sendJson(401, F("{\"ok\":false,\"error\":\"Invalid OTA authorization code\"}")); return; }
      if (uploading) { sendJson(409, F("{\"ok\":false,\"error\":\"Update is active\"}")); return; }
      lastActivityMs = millis();
      AtechWifiProfile profile;
      profile.ssid = server->arg("ssid");
      profile.pass = server->arg("pass");
      profile.identity = server->arg("ident");
      profile.username = server->arg("user");
      profile.ca = server->arg("ca");
      profile.cert = server->arg("crt");
      profile.key = server->arg("key");
      profile.domain = server->arg("domain");
      profile.caBundle = server->arg("ca_bundle") == "1";
      if (!AtechWifiLan::parseAuth(server->arg("auth"), profile.auth)) { sendJson(400, F("{\"ok\":false,\"error\":\"Unknown Wi-Fi security method\"}")); return; }
      if (!AtechWifiLan::parsePhase2(server->arg("ph2"), profile.phase2)) { sendJson(400, F("{\"ok\":false,\"error\":\"Unknown TTLS phase 2 method\"}")); return; }
      if (!lan->saveProfile(profile)) {
        sendJson(400, String(F("{\"ok\":false,\"error\":\"")) + jsonEscape(lan->lastError()) + F("\"}"));
        return;
      }
      Serial.printf("[hotspot] Wi-Fi profile saved for \"%s\" (%s); joining\n", profile.ssid.c_str(), AtechWifiLan::authName(profile.auth));
      sendJson(200, F("{\"ok\":true,\"joining\":true}"));
    });
    server->on("/api/wifi/forget", HTTP_POST, [this, lan]() {
      if (!authorize()) { sendJson(401, F("{\"ok\":false,\"error\":\"Invalid OTA authorization code\"}")); return; }
      if (uploading || lan->isTransferring()) { sendJson(409, F("{\"ok\":false,\"error\":\"Update is active\"}")); return; }
      lastActivityMs = millis();
      if (!lan->forgetCredentials()) { sendJson(500, F("{\"ok\":false,\"error\":\"Could not erase the credentials\"}")); return; }
      sendJson(200, F("{\"ok\":true}"));
    });
  }

  // Cloud OTA agent: status for anyone on the hotspot, URL changes behind the code.
  void configureCloudRoutes() {
    AtechCloudOta *cloud = config.cloud;
    if (!cloud) return;
    server->on("/api/cloud/status", HTTP_GET, [this, cloud]() {
      sendJson(200, cloud->statusJson());
    });
    server->on("/api/cloud/save", HTTP_POST, [this, cloud]() {
      if (!authorize()) { sendJson(401, F("{\"ok\":false,\"error\":\"Invalid OTA authorization code\"}")); return; }
      if (uploading || cloud->isTransferring()) { sendJson(409, F("{\"ok\":false,\"error\":\"Update is active\"}")); return; }
      lastActivityMs = millis();
      if (!cloud->setServerUrl(server->arg("url"))) {
        sendJson(400, String(F("{\"ok\":false,\"error\":\"")) + jsonEscape(cloud->lastError()) + F("\"}"));
        return;
      }
      sendJson(200, F("{\"ok\":true}"));
    });
    server->on("/api/cloud/clear", HTTP_POST, [this, cloud]() {
      if (!authorize()) { sendJson(401, F("{\"ok\":false,\"error\":\"Invalid OTA authorization code\"}")); return; }
      lastActivityMs = millis();
      if (!cloud->clearServerUrl()) { sendJson(500, F("{\"ok\":false,\"error\":\"Could not clear the server URL\"}")); return; }
      sendJson(200, F("{\"ok\":true}"));
    });
  }

  // Chooses the transport and starts or stops the hotspot accordingly (see AtechWifiOtaConfig).
  void evaluatePolicy(uint32_t now) {
    const bool wifiConfigured = config.lan && config.lan->hasCredentials();
    const bool cloudEnabled = config.cloud && config.cloud->isEnabled();
    // "Online" is a session with a recent successful exchange, not a bearer token that is never aged:
    // a station that is associated while the internet is gone must bring the hotspot up too.
    const bool cloudOnline = config.cloud && config.cloud->hasSession() && config.cloud->lastContactAgeMs() < CLOUD_CONTACT_MAX_MS;
    const bool captive = config.lan && strcmp(config.lan->internetState(), "captive") == 0;
    if (cloudOnline) { cloudLostMs = 0; if (cloudBackMs == 0) cloudBackMs = now; }
    else { cloudBackMs = 0; if (cloudLostMs == 0) cloudLostMs = now; }
    if (active && WiFi.softAPgetStationNum() > 0) lastClientMs = now;
    reason = cloudOnline ? "online" : (active && manualStart) ? "manual" : !wifiConfigured ? "no_wifi" : !cloudEnabled ? "no_cloud_url" : captive ? "captive" : "offline";
    if (!config.autoStart) return;
    if (!active) {
      const bool wanted = !wifiConfigured || (cloudEnabled && !cloudOnline && now - cloudLostMs >= config.offlineGraceMs);
      const bool suppressed = manualStopMs != 0 && now - manualStopMs < MANUAL_SUPPRESS_MS;
      if (wanted && !suppressed && rebootAtMs == 0 && !(config.otherOtaBusy && config.otherOtaBusy())) {
        if (startPortal()) { autoStarted = true; manualStart = false; Serial.printf("[hotspot] started by the controller (%s)\n", reason); }
      }
      return;
    }
    // A board that is back on the cloud (or on a LAN-only network) for long enough closes an
    // auto-started hotspot once nobody is using it; never during an upload or the sign-in helper.
    const bool lanOnly = wifiConfigured && !cloudEnabled && config.lan && config.lan->isConnected();
    const bool settled = (cloudOnline && now - cloudBackMs >= config.onlineGraceMs) || lanOnly;
    const bool quiet = WiFi.softAPgetStationNum() == 0 && (lastClientMs == 0 || now - lastClientMs >= CLIENT_RECENT_MS);
    if (autoStarted && !manualStart && settled && quiet && !uploading && !helperActive && rebootAtMs == 0) {
      Serial.println(F("[hotspot] the board is reachable again; closing the hotspot"));
      if (stopPortal()) autoStarted = false;
    }
  }

  bool setHelper(bool on) {
    if (!config.lan || !active) { error = F("The hotspot is not running"); return false; }
    if (on == helperActive) return true;
    if (on) {
      if (!config.lan->isConnected()) { error = F("The board is not on a network to sign in to; join one first"); return false; }
      if (!WiFi.softAPConfig(AP_IP, AP_IP, AP_MASK, IPAddress(192, 168, 4, 2), WiFi.dnsIP())) { error = F("Could not hand out the upstream DNS"); return false; }
      if (!WiFi.AP.enableNAPT(true)) {
        WiFi.softAPConfig(AP_IP, AP_IP, AP_MASK, IPAddress(192, 168, 4, 2), AP_IP);
        error = F("Could not enable NAT on the hotspot");
        return false;
      }
      helperActive = true;
      helperStartedMs = millis();
      helperRecheckMs = millis();
      Serial.println(F("[hotspot] sign-in helper on: hotspot clients are routed through the station"));
      return true;
    }
    WiFi.AP.enableNAPT(false);
    WiFi.softAPConfig(AP_IP, AP_IP, AP_MASK, IPAddress(192, 168, 4, 2), AP_IP);
    helperActive = false;
    Serial.println(F("[hotspot] sign-in helper off"));
    return true;
  }

  // Internet access: the probe result for anyone on the hotspot; the helper and a recheck behind the code.
  void configureNetRoutes() {
    AtechWifiLan *lan = config.lan;
    if (!lan) return;
    server->on("/api/net/helper", HTTP_POST, [this]() {
      if (!authorize()) { sendJson(401, F("{\"ok\":false,\"error\":\"Invalid OTA authorization code\"}")); return; }
      if (uploading) { sendJson(409, F("{\"ok\":false,\"error\":\"Update is active\"}")); return; }
      lastActivityMs = millis();
      if (!setHelper(server->arg("on") != "0")) { sendJson(409, String(F("{\"ok\":false,\"error\":\"")) + jsonEscape(error) + F("\"}")); return; }
      sendJson(200, String(F("{\"ok\":true,\"helper\":")) + (helperActive ? F("true") : F("false")) + F("}"));
    });
    server->on("/api/net/recheck", HTTP_POST, [this, lan]() {
      if (!authorize()) { sendJson(401, F("{\"ok\":false,\"error\":\"Invalid OTA authorization code\"}")); return; }
      lastActivityMs = millis();
      lan->recheckInternet();
      sendJson(200, F("{\"ok\":true}"));
    });
  }

  // Firmware signing key: readable by anyone on the hotspot, changed only with the code.
  void configureSignRoutes() {
    server->on("/api/sign/status", HTTP_GET, [this]() {
      sendJson(200, atech::fwsign::statusJson());
    });
    server->on("/api/sign/save", HTTP_POST, [this]() {
      if (!authorize()) { sendJson(401, F("{\"ok\":false,\"error\":\"Invalid OTA authorization code\"}")); return; }
      if (uploading) { sendJson(409, F("{\"ok\":false,\"error\":\"Update is active\"}")); return; }
      lastActivityMs = millis();
      const String key = server->arg("pubkey");
      const bool replace = server->arg("replace") == "1";
      const bool ok = replace ? atech::fwsign::replaceKey(key, "hotspot") : atech::fwsign::pinKey(key, "hotspot");
      if (!ok) {
        sendJson(400, F("{\"ok\":false,\"error\":\"Signing key refused: expected 130 hex characters of an uncompressed P-256 point; a different key is already trusted unless replace=1\"}"));
        return;
      }
      sendJson(200, F("{\"ok\":true}"));
    });
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
    const esp_partition_t *next = esp_ota_get_next_update_partition(nullptr);
    String json;
    json.reserve(720);
    json += F("{\"device\":\"");
    json += jsonEscape(deviceName);
    json += F("\",\"device_id\":\"");
    json += atech::deviceId();
    json += F("\",\"demo\":");
    json += String(config.demo);
    json += F(",\"version\":\"");
    json += jsonEscape(firmwareVersion);
    json += F("\",\"ssid\":\"");
    json += jsonEscape(apSsid);
    json += F("\",\"hostname\":\"");
    json += jsonEscape(hostnameText);
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
    json += next ? String(next->size) : String(0);
    json += F(",\"sign\":");
    json += atech::fwsign::statusJson();
    json += F(",\"internet\":\"");
    json += config.lan ? config.lan->internetState() : "unknown";
    json += F("\",\"captive_url\":\"");
    json += jsonEscape(config.lan ? config.lan->captiveUrl() : String());
    json += F("\",\"helper\":");
    json += helperActive ? F("true") : F("false");
    json += F(",\"mac\":\"");
    json += config.lan ? config.lan->stationMac() : String();
    json += F("\",\"error\":\"");
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
    Serial.printf("[hotspot] update failed: %s\n", error.c_str());
  }

  void abortUpload(const String &message, bool recordFailure = true) {
    const bool owned = uploading || sink.active();
    sink.abort();
    uploading = false;
    manifestPresent = false;
    if (owned) atech::coreReleaseOta("hotspot");
    if (recordFailure) setFailure(message);
  }

  // The request headers the page sends from the .atech header (all optional for a raw .bin).
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
    manifestPresent = false;

    if (!authorize()) {
      setFailure(F("Invalid OTA authorization code"), 401);
      return false;
    }
    if (config.otherOtaBusy && config.otherOtaBusy()) {
      setFailure(F("Another update owns the flash; wait for it to finish"), 409);
      return false;
    }
    if (config.lan && config.lan->isTransferring()) {
      setFailure(F("A Wi-Fi network update is active; wait for it to finish"), 409);
      return false;
    }
    String filename = upload.filename;
    filename.toLowerCase();
    if (!filename.endsWith(".bin") && !filename.endsWith(".atech")) {
      setFailure(F("Only .atech update packages or application .bin files are accepted"));
      return false;
    }
    if (!parseUnsigned(server->header("X-Atech-Firmware-Size"), expectedBytes) || expectedBytes < MIN_IMAGE_BYTES) {
      setFailure(F("Missing or invalid firmware size"));
      return false;
    }
    String sha = server->header("X-Atech-SHA256");
    sha.toLowerCase();
    if (!sha.isEmpty() && !isHex(sha, 64)) { setFailure(F("Invalid firmware SHA-256")); return false; }
    const String build = server->header("X-Atech-Build");
    if (!validBuildId(build)) { setFailure(F("Invalid build id")); return false; }
    String signature = server->header("X-Atech-Sig");
    signature.toLowerCase();
    String target = server->header("X-Atech-Target");
    target.trim();
    target.toUpperCase();
    uint32_t version = 0;
    uint32_t demo = 0;
    if (!signature.isEmpty()) {
      if (!isHex(signature, 128)) { setFailure(F("Invalid firmware signature")); return false; }
      if (build.isEmpty() || sha.isEmpty()) { setFailure(F("A signed update package needs its build id and digest")); return false; }
      if (!parseUnsigned(server->header("X-Atech-Version"), version)) { setFailure(F("Missing or invalid firmware version")); return false; }
      const String demoText = server->header("X-Atech-Demo");
      if (!demoText.isEmpty() && (!parseUnsigned(demoText, demo) || demo != config.demo)) {
        setFailure(String(F("This update package is for Demo ")) + demoText + F("; this board runs Demo ") + String(config.demo), 422);
        return false;
      }
      if (!target.isEmpty() && target != atech::deviceId()) {
        setFailure(String(F("This update package was signed for ")) + target + F(", not for this board"), 422);
        return false;
      }
    }
    // The key rides with the upload and is pinned in finishUpload() once the sink accepted the image:
    // a refused package from the wrong backend must not lock this board to that backend's key.
    pendingKey = server->header("X-Atech-Key");
    pendingKey.toLowerCase();

    if (!atech::coreTryAcquireOta("hotspot")) {
      setFailure(String(F("Flash is owned by the ")) + atech::coreOtaOwner() + F(" updater"), 409);
      return false;
    }
    String reason;
    if (!sink.begin(expectedBytes, sha, build, imageIdentity, reason)) {
      atech::coreReleaseOta("hotspot");
      setFailure(reason, reason.startsWith("Could not") ? 500 : 400);
      return false;
    }
    if (!signature.isEmpty()) {
      atech::fwsign::Manifest manifest;
      manifest.build = build;
      manifest.demo = config.demo;
      manifest.size = expectedBytes;
      manifest.sha256 = sha;
      manifest.version = version;
      manifest.downgrade = server->header("X-Atech-Downgrade") == "1";
      manifest.target = target;
      manifest.signature = signature;
      if (!atech::fwsign::hasKey()) manifest.candidateKey = pendingKey;
      sink.setManifest(manifest);
      manifestPresent = true;
    }
    uploading = true;
    uploadState = UploadState::Receiving;
    lastActivityMs = millis();
    Serial.printf("[hotspot] upload started: %lu bytes into %s (%s)\n", static_cast<unsigned long>(expectedBytes), sink.partitionLabel(),
                  manifestPresent ? "signed package" : "unsigned image");
    return true;
  }

  void writeUpload(const uint8_t *data, size_t length) {
    if (!uploading || uploadState != UploadState::Receiving || length == 0) return;
    lastActivityMs = millis();
    String reason;
    if (!sink.write(data, length, reason)) {
      abortUpload(reason);
      return;
    }
    receivedBytes = sink.received();
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

  // The one-shot marker that brings the hotspot back after the reboot so the page can show the
  // running version. Persisted before the sink selects the slot; cleared when the image is refused.
  bool persistRebootMarker() {
    Preferences preferences;
    if (!preferences.begin(preferencesNamespace.c_str(), false)) return false;
    const bool stored =
        preferences.putString("prev_ver", firmwareVersion) == firmwareVersion.length() &&
        preferences.putBool("resume", true) == 1;
    if (!stored) preferences.remove("resume");
    preferences.end();
    resumeMarkerNeedsClear = stored;
    return stored;
  }

  void rememberDigest(const String &digest) {
    Preferences preferences;
    if (!preferences.begin(preferencesNamespace.c_str(), false)) return;
    preferences.putString("last_sha", digest);
    preferences.end();
  }

  void finishUpload(HTTPUpload &upload) {
    if (!uploading || uploadState != UploadState::Receiving) return;
    lastActivityMs = millis();
    if (upload.totalSize != expectedBytes || sink.received() != expectedBytes) {
      abortUpload(F("Upload was incomplete or its length differs from the declared size; inactive partition was not selected"));
      return;
    }
    uploadState = UploadState::Verifying;
    if (!persistRebootMarker()) {
      abortUpload(F("Verified image was not selected because post-reboot status could not be persisted"));
      return;
    }
    // Completeness, markers, digest, signature, version policy, ESP image validation and slot selection.
    String reason;
    if (!sink.finish(reason)) {
      clearRebootMarker();
      abortUpload(reason, false);
      setFailure(reason, 422);
      return;
    }
    if (!pendingKey.isEmpty() && !atech::fwsign::hasKey()) atech::fwsign::pinKey(pendingKey, "hotspot");
    pendingKey = String();
    imageSha256 = sink.digestHex();
    rememberDigest(imageSha256);
    uploading = false;
    uploadState = UploadState::Verified;
    responseStatus = 200;
    error = "";
    // The flash lock is held until the restart.
    rebootAtMs = millis() + config.rebootDelayMs;
    Serial.printf("[hotspot] verified %lu bytes (%s), SHA-256 %s; reboot scheduled\n", static_cast<unsigned long>(expectedBytes),
                  manifestPresent ? "signed" : "unsigned", imageSha256.c_str());
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
        if (uploading) {
          abortUpload(F("Browser disconnected; incomplete update discarded"));
        }
        break;
    }
  }

  void handleUpdateResponse() {
    if (uploadState == UploadState::Verified) {
      String json = F("{\"ok\":true,\"stage\":\"verified\",\"bytes\":");
      json += String(expectedBytes);
      json += F(",\"sha256\":\"");
      json += imageSha256;
      json += F("\",\"signed\":");
      json += manifestPresent ? F("true") : F("false");
      json += F(",\"reboot_in_ms\":");
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
        "X-Atech-OTA-Key", "X-Atech-Firmware-Size", "X-Atech-SHA256", "X-Atech-Build", "X-Atech-Version",
        "X-Atech-Downgrade", "X-Atech-Target", "X-Atech-Sig", "X-Atech-Key", "X-Atech-Demo"};
    server->collectHeaders(headers, sizeof(headers) / sizeof(headers[0]));
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
      manualStopMs = millis();
    });
    // Captive-portal probes: the operating system opens this page by itself after joining.
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

  // Leaves the radio in station mode when a home network is configured,
  // otherwise switches it off as the original portal did.
  void releaseRadio() {
    if (config.lan) config.lan->setSoftApActive(false);
    else WiFi.mode(WIFI_OFF);
  }

  bool startPortal() {
    if (!initialized || active) return active;
    if (config.otherOtaBusy && config.otherOtaBusy()) {
      error = F("Hotspot refused: another update owns the flash");
      Serial.println(error);
      return false;
    }
    if (config.modeChanged) config.modeChanged(true);
    // Close the small race between the first busy check and advertising being
    // stopped. Never proceed if a BLE client connected in that interval.
    if (config.otherOtaBusy && config.otherOtaBusy()) {
      error = F("Hotspot refused: Bluetooth became active; disconnect and retry");
      if (config.modeChanged) config.modeChanged(false);
      Serial.println(error);
      return false;
    }

    // With a station manager the hotspot shares the radio with the home
    // network (AP+STA) so a join can be verified from this page; otherwise
    // the AP is the only interface.
    if (config.lan) config.lan->setSoftApActive(true);
    else WiFi.mode(WIFI_AP);
    if (!WiFi.softAPConfig(AP_IP, AP_IP, AP_MASK, IPAddress(192, 168, 4, 2), AP_IP) ||
        !WiFi.softAP(apSsid.c_str(), apPassword.c_str(), 1, 0, 4, false,
                     WIFI_AUTH_WPA2_PSK, WIFI_CIPHER_TYPE_CCMP)) {
      error = F("Could not start WPA2 SoftAP");
      WiFi.softAPdisconnect(true);
      releaseRadio();
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
      releaseRadio();
      if (config.modeChanged) config.modeChanged(false);
      Serial.println(error);
      return false;
    }

    configureRoutes();
    configureWifiRoutes();
    configureCloudRoutes();
    configureNetRoutes();
    configureSignRoutes();
    if (!dns->start(DNS_PORT, "*", AP_IP)) {
      Serial.println(F("Warning: captive DNS did not start; use http://192.168.4.1 directly"));
    }
    // atech-<suffix>.local answers on the hotspot as well as on the home network.
    if (config.lan) config.lan->ensureMdns();
    else if (!MDNS.begin(hostnameText.c_str())) Serial.println(F("Warning: mDNS did not start on the hotspot"));
    server->begin();
    active = true;
    error = "";
    uploadState = UploadState::Idle;
    lastActivityMs = millis();
    if (resumeMarkerNeedsClear && !clearRebootMarker()) {
      Serial.println(F("Warning: post-update portal started but its one-shot marker could not be cleared"));
    }
    printCredentials();
    Serial.printf("[hotspot] %s is up for %lu seconds of inactivity\n", apSsid.c_str(),
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
    if (helperActive) { WiFi.AP.enableNAPT(false); helperActive = false; }
    WiFi.softAPdisconnect(true);
    releaseRadio();
    active = false;
    stopAtMs = 0;
    postUpdateBoot = false;
    uploadState = UploadState::Idle;
    if (config.modeChanged) config.modeChanged(false);
    Serial.println(F("[hotspot] closed"));
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
      if (buttonWasPressed && !buttonHandled && config.shortPress) config.shortPress();
      buttonWasPressed = false;
      buttonHandled = false;
    } else if (!buttonHandled && millis() - buttonPressedMs >= config.buttonHoldMs) {
      buttonHandled = true;
      if (active) {
        if (!uploading && rebootAtMs == 0 && stopPortal()) { autoStarted = false; manualStart = false; manualStopMs = millis(); }
      } else if (startPortal()) {
        manualStart = true;
        autoStarted = false;
        manualStopMs = 0;
      }
    }
  }

  void service() {
    if (!initialized) return;
    uint32_t now = millis();
    if (rebootAtMs != 0 && static_cast<int32_t>(now - rebootAtMs) >= 0) {
      Serial.println(F("[hotspot] rebooting into the verified image"));
      Serial.flush();
      delay(50);
      ESP.restart();
    }
    handleButton();
    if (now - lastPolicyMs >= POLICY_INTERVAL_MS) { lastPolicyMs = now; evaluatePolicy(now); }
    if (!active) return;
    if (dns) dns->processNextRequest();
    if (server) server->handleClient();

    now = millis();
    if (rebootAtMs != 0 && static_cast<int32_t>(now - rebootAtMs) >= 0) {
      Serial.println(F("[hotspot] rebooting into the verified image"));
      Serial.flush();
      delay(50);
      ESP.restart();
    }
    if (stopAtMs != 0 && static_cast<int32_t>(now - stopAtMs) >= 0) {
      stopPortal();
      return;
    }
    // The helper rechecks the internet every 15 s and turns itself off once the board is through (or after 15 min).
    if (helperActive && config.lan) {
      if (now - helperRecheckMs >= 15000) { helperRecheckMs = now; config.lan->recheckInternet(); }
      if (strcmp(config.lan->internetState(), "ok") == 0) { Serial.println(F("[hotspot] the network accepted the sign-in")); setHelper(false); lastActivityMs = now; }
      else if (now - helperStartedMs >= 15UL * 60UL * 1000UL) setHelper(false);
    }
    // The inactivity timeout applies to a hotspot the user (or the post-update marker) started; an
    // auto-started one stays until the controller sees the board reachable again.
    if (!uploading && !autoStarted && config.inactivityTimeoutMs > 0 &&
        now - lastActivityMs >= config.inactivityTimeoutMs) {
      Serial.println(F("[hotspot] closed after inactivity"));
      if (stopPortal()) manualStart = false;
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
  _impl->ssidPrefix = config.ssidPrefix ? config.ssidPrefix : "ATECH";
  _impl->hostnamePrefix = config.hostnamePrefix ? config.hostnamePrefix : "atech";
  _impl->imageIdentity = config.imageIdentity ? config.imageIdentity : "";
  _impl->preferencesNamespace =
      config.preferencesNamespace ? config.preferencesNamespace : "atechota";
  if (_impl->imageIdentity.length() < 8) {
    _impl->error = F("Image identity marker must contain at least 8 characters");
    Serial.printf("Hotspot disabled: %s\n", _impl->error.c_str());
    return false;
  }
  if (_impl->config.buttonHoldMs == 0) _impl->config.buttonHoldMs = 3000;
  if (_impl->config.inactivityTimeoutMs == 0) {
    _impl->config.inactivityTimeoutMs = 10UL * 60UL * 1000UL;
  }
  if (_impl->config.rebootDelayMs < 1000) _impl->config.rebootDelayMs = 2200;
  if (_impl->config.offlineGraceMs == 0) _impl->config.offlineGraceMs = 90000;
  if (_impl->config.onlineGraceMs == 0) _impl->config.onlineGraceMs = 60000;

  // The last three MAC bytes are device-unique; the first three are the
  // Espressif OUI shared by every chip from the same batch.
  uint8_t mac[6] = {};
  esp_efuse_mac_get_default(mac);
  char suffix[7];
  snprintf(suffix, sizeof(suffix), "%02X%02X%02X", mac[3], mac[4], mac[5]);
  _impl->apSsid = _impl->ssidPrefix + "-" + suffix;
  _impl->hostnameText = config.lan ? config.lan->hostname() : _impl->hostnamePrefix + "-" + suffix;
  _impl->hostnameText.toLowerCase();
  if (!_impl->loadCredentials()) {
    Serial.printf("Hotspot disabled: %s\n", _impl->error.c_str());
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
    Serial.println(F("Successful hotspot update marker found; restoring the page for verification"));
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

String AtechWifiOtaPortal::hostname() const { return _impl ? _impl->hostnameText : String(); }

const String &AtechWifiOtaPortal::lastError() const {
  static const String empty;
  return _impl ? _impl->error : empty;
}

const String &AtechWifiOtaPortal::otaToken() const {
  static const String empty;
  return _impl ? _impl->otaToken : empty;
}

const String &AtechWifiOtaPortal::apPassword() const {
  static const String empty;
  return _impl ? _impl->apPassword : empty;
}

String AtechWifiOtaPortal::hotspotReport() const {
  if (!_impl || !_impl->initialized) return String();
  return String(F("ap_ssid=")) + formEncode(_impl->apSsid) + F("&ap_pass=") + formEncode(_impl->apPassword);
}

const char *AtechWifiOtaPortal::transport() const {
  if (!_impl) return "none";
  if (_impl->config.cloud && _impl->config.cloud->hasSession() && _impl->config.cloud->lastContactAgeMs() < CLOUD_CONTACT_MAX_MS) return "cloud";
  return _impl->active ? "hotspot" : "none";
}

const char *AtechWifiOtaPortal::transportReason() const { return _impl ? _impl->reason : "offline"; }

String AtechWifiOtaPortal::transportJson() const {
  if (!_impl) return String("{}");
  String json;
  json.reserve(200);
  json += F("{\"transport\":\""); json += transport();
  json += F("\",\"reason\":\""); json += _impl->reason;
  json += F("\",\"hotspot\":"); json += _impl->active ? F("true") : F("false");
  json += F(",\"ssid\":\""); json += jsonEscape(_impl->apSsid);
  json += F("\",\"hostname\":\""); json += jsonEscape(_impl->hostnameText);
  json += F("\",\"helper\":"); json += _impl->helperActive ? F("true") : F("false");
  json += '}';
  return json;
}

String AtechWifiOtaPortal::transportReport() const {
  if (!_impl) return String();
  return String(F("transport=")) + transport() + F("&reason=") + _impl->reason + F("&hotspot=") + (_impl->active ? '1' : '0');
}
