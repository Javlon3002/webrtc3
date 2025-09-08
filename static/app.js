/* Minimal Janus VideoRoom client (modular, no URL field)
   - Auto targets wss://<host>/janus or ws://<host>/janus
   - Join/Leave, publish local A/V
   - Two selectable remote subscribers
   - Toggle mic/camera with clear labels
   - Verbose debug log
*/

const ROOM_ID = 12345; // change if you use a different room

// Auto-resolve Janus endpoint (assumes Nginx reverse-proxy at /janus)
const JANUS_URL =
  (location.protocol === "https:" ? "wss://" : "ws://") +
  location.host + "/janus";

let janus = null;
let pub = null;                  // publisher handle
let subA = null, subB = null;    // two subscriber handles
let myStream = null;
let myId = null, myPrivateId = null;
let publishers = [];             // [{id, display}, ...]

/* ---------- small DOM helpers ---------- */
const $ = id => document.getElementById(id);
const log = (...a) => { const l = $('log'); l.textContent += a.join(' ') + "\n"; l.scrollTop = l.scrollHeight; };

function setConnectedUI(connected){
  $('joinBtn').disabled = connected;
  $('leaveBtn').disabled = !connected;
  $('toggleMicBtn').disabled = !connected;
  $('toggleCamBtn').disabled = !connected;
  $('remoteSelect1').disabled = !connected;
  $('remoteSelect2').disabled = !connected;
}

function fillSelects(){
  const opts = ['<option value="">— pick a participant —</option>'];
  publishers.forEach(p => { if (p.id !== myId) opts.push(`<option value="${p.id}">${p.display || p.id}</option>`); });
  $('remoteSelect1').innerHTML = opts.join('');
  $('remoteSelect2').innerHTML = opts.join('');
}

/* ---------- Janus bootstrap ---------- */
function createJanus(){
  return new Promise((resolve, reject)=>{
    Janus.init({
      debug: "all",
      callback: ()=>{
        if(!Janus.isWebrtcSupported()) return reject(new Error("WebRTC unsupported"));
        janus = new Janus({
          server: JANUS_URL,
          success: ()=> resolve(),
          error: err => reject(err),
          destroyed: ()=> { setConnectedUI(false); log("[janus] destroyed"); }
        });
      }
    });
  });
}

function attachPublisher(){
  return new Promise((resolve, reject)=>{
    janus.attach({
      plugin: "janus.plugin.videoroom",
      success: handle => {
        pub = handle;
        log("[pub] attached (", JANUS_URL, ")");
        // Try to create; OK if it already exists
        pub.send({ message: { request: "create", room: ROOM_ID, description: "room-"+ROOM_ID, bitrate: 0 }});
        // Join as publisher
        const display = `User-${Math.floor(Math.random()*1000)}`;
        pub.send({ message: { request: "join", room: ROOM_ID, ptype: "publisher", display }});
        resolve();
      },
      error: err => reject(err),
      onmessage: (msg, jsep) => {
        const ev = msg["videoroom"];
        if(ev === "joined"){
          myId = msg["id"];
          myPrivateId = msg["private_id"];
          log(`[pub] joined room ${ROOM_ID} as id=${myId}`);
          if(msg["publishers"]) { publishers = msg["publishers"]; fillSelects(); }
          publishOwnFeed();
        } else if(ev === "event"){
          if(msg["publishers"]) { publishers = msg["publishers"]; fillSelects(); }
          if(msg["leaving"] || msg["unpublished"]){
            const leftId = msg["leaving"] || msg["unpublished"];
            publishers = publishers.filter(p => p.id !== leftId);
            fillSelects();
            if(subA && subA.feedId === leftId) detachSub('A');
            if(subB && subB.feedId === leftId) detachSub('B');
          }
        }
        if(jsep){ pub.handleRemoteJsep({ jsep }); }
      },
      onlocaltrack: (track, on) => {
        if(on){
          if(!$('localVideo').srcObject){
            const ms = new MediaStream();
            $('localVideo').srcObject = ms;
            $('localVideo').play().catch(()=>{ /* autoplay gate */ });
          }
          $('localVideo').srcObject.addTrack(track);
        }
      },
      onremotetrack: ()=>{},
      webrtcState: up => log("[pub] webrtc", up ? "up" : "down"),
      iceState: s => log("[pub] ice:", s),
      mediaState: (t, r) => log(`[pub] media ${t} receiving=${r}`),
      oncleanup: ()=> log("[pub] cleanup"),
    });
  });
}

function publishOwnFeed(){
  pub.createOffer({
    media: { audio: true, video: true, data: false },
    success: jsep => {
      pub.send({ message: { request: "configure", audio: true, video: true }, jsep });
      setConnectedUI(true);
      log("[pub] local offer created, starting publish");
    },
    error: err => { log("[pub] createOffer error:", err); alert("Cannot publish local stream."); }
  });
}

/* ---------- subscribers ---------- */
function attachSubscriber(slot, feedId){
  const setSlot = (h, id) => { h.feedId = id; h.slot = slot; };
  return new Promise((resolve, reject)=>{
    janus.attach({
      plugin: "janus.plugin.videoroom",
      success: handle => {
        if(slot === 'A') subA = handle; else subB = handle;
        setSlot(handle, feedId);
        log(`[sub${slot}] attached -> join feed ${feedId}`);
        handle.send({ message: { request: "join", room: ROOM_ID, ptype: "subscriber", feed: feedId, private_id: myPrivateId } });
        resolve();
      },
      error: err => reject(err),
      onmessage: (msg, jsep)=>{
        const ev = msg["videoroom"];
        if(ev === "attached") log(`[sub${slot}] attached to feed ${feedId}`);
        if(jsep){
          const h = (slot === 'A' ? subA : subB);
          h.createAnswer({
            jsep,
            media: { audioSend: false, videoSend: false, data: false },
            success: jsepAnswer => { h.send({ message: { request: "start", room: ROOM_ID }, jsep: jsepAnswer }); },
            error: err => log(`[sub${slot}] createAnswer error`, err)
          });
        }
      },
      onremotetrack: (track, on)=>{
        const v = $(slot === 'A' ? 'remoteVideo1' : 'remoteVideo2');
        if(on){
          if(!v.srcObject){ v.srcObject = new MediaStream(); }
          v.srcObject.addTrack(track);
        } else if(v.srcObject){
          v.srcObject.removeTrack(track);
        }
      },
      webrtcState: up => log(`[sub${slot}] webrtc`, up ? "up" : "down"),
      oncleanup: ()=> { const v = $(slot === 'A' ? 'remoteVideo1' : 'remoteVideo2'); v.srcObject = null; log(`[sub${slot}] cleanup`); }
    });
  });
}

function detachSub(slot){
  const h = slot === 'A' ? subA : subB;
  if(!h) return;
  log(`[sub${slot}] detaching`);
  h.hangup(); h.detach();
  if(slot === 'A') subA = null; else subB = null;
  $(slot === 'A' ? 'remoteVideo1' : 'remoteVideo2').srcObject = null;
}

/* ---------- leave ---------- */
function leaveRoom(){
  try {
    if(subA) detachSub('A');
    if(subB) detachSub('B');
    if(pub){
      pub.send({ message: { request: "leave" }});
      pub.hangup(); pub.detach(); pub = null;
    }
    if(janus){ janus.destroy(); janus = null; }
  } catch(e){}
  setConnectedUI(false);
  fillSelects();
  log("Left room.");
}

/* ---------- UI ---------- */
window.addEventListener('DOMContentLoaded', ()=>{
  setConnectedUI(false);
  fillSelects();

  $('joinBtn').addEventListener('click', async ()=>{
    try{
      log("[ui] join clicked; endpoint =", JANUS_URL);
      await createJanus();
      await attachPublisher();
      log("Connected.");
    }catch(e){
      console.error(e); log("[err]", e.toString()); alert("Failed to connect: " + e);
      setConnectedUI(false);
    }
  });

  $('leaveBtn').addEventListener('click', leaveRoom);

  $('toggleMicBtn').addEventListener('click', ()=>{
    const v = $('localVideo'); const s = v.srcObject;
    if(!s) return;
    const t = s.getAudioTracks()[0]; if(!t) return;
    t.enabled = !t.enabled;
    $('toggleMicBtn').textContent = t.enabled ? "Mute mic" : "Unmute mic";
    log("[ui] mic", t.enabled ? "on" : "off");
  });

  $('toggleCamBtn').addEventListener('click', ()=>{
    const v = $('localVideo'); const s = v.srcObject;
    if(!s) return;
    const t = s.getVideoTracks()[0]; if(!t) return;
    t.enabled = !t.enabled;
    $('toggleCamBtn').textContent = t.enabled ? "Camera off" : "Camera on";
    log("[ui] camera", t.enabled ? "on" : "off");
  });

  $('remoteSelect1').addEventListener('change', async (e)=>{
    const feed = parseInt(e.target.value || "0", 10);
    if(subA) detachSub('A');
    if(feed) await attachSubscriber('A', feed);
  });
  $('remoteSelect2').addEventListener('change', async (e)=>{
    const feed = parseInt(e.target.value || "0", 10);
    if(subB) detachSub('B');
    if(feed) await attachSubscriber('B', feed);
  });
});
