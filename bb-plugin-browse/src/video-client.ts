/** Bounded WebCodecs decoder. No media tracks, vendor UI, or persistent frame queues. */
export const videoWorker = `let decoder = null,
  codec = "",
  count = 0;
const pendingTimes=new Map();
function close() {
  decoder?.close();
  decoder = null;
  codec = "";
  pendingTimes.clear();
}
onmessage = async (e) => {
  try {
    const bytes = new Uint8Array(e.data);
    if (bytes.length < 11 || bytes[0] !== 4)
      throw Error("Unsupported video packet");
    const key = bytes[1] === 1,
      w = (bytes[6] << 8) | bytes[7],
      h = (bytes[8] << 8) | bytes[9];
    if (w !== 1280 || h !== 800) throw Error("Unsupported video dimensions");
    const data = bytes.subarray(10);
    let next = codec;
    if (key) {
      for (let i = 0; i < data.length - 7; i++) {
        let n = 0;
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) n = i + 3;
        else if (
          data[i] === 0 &&
          data[i + 1] === 0 &&
          data[i + 2] === 0 &&
          data[i + 3] === 1
        )
          n = i + 4;
        if (n && (data[n] & 31) === 7) {
          next =
            "avc1." +
            [data[n + 1], data[n + 2], data[n + 3]]
              .map((v) => v.toString(16).padStart(2, "0"))
              .join("");
          break;
        }
      }
    }
    if (!next) {
      return;
    }
    if (!decoder || next !== codec) {
      if (!key) return;
      close();
      codec = next;
      decoder = new VideoDecoder({
        output: (frame) => {
          const decodeMs=performance.now()-(pendingTimes.get(frame.timestamp)||performance.now());pendingTimes.delete(frame.timestamp);
          try {
            postMessage(
              { frame, decodeMs, width: frame.displayWidth, height: frame.displayHeight },
              [frame],
            );
          } finally {
            frame.close();
          }
        },
        error: () => {
          postMessage({ error: "Video decoding failed" });
          close();
        },
      });
      decoder.configure({
        codec,
        codedWidth: w,
        codedHeight: h,
        optimizeForLatency: true,
        hardwareAcceleration: "no-preference",
      });
    }
    if (decoder.decodeQueueSize >= 8) throw Error("Video decoding fell behind");
    const timestamp=++count*33333;pendingTimes.set(timestamp,performance.now());
    decoder.decode(
      new EncodedVideoChunk({
        type: key ? "key" : "delta",
        timestamp,
        data,
      }),
    );
  } catch (error) {
    postMessage({ error: String(error) });
    close();
  }
};
`;
export const videoClient = `
let videoAvailable=document.body.dataset.video==='1'||new URL(location.href).searchParams.get('video')==='1',videoMode=videoAvailable,videoWorker=null,videoUrl=null,videoOutstanding=0;
function stopVideo(){videoWorker?.terminate();videoWorker=null;if(videoUrl)URL.revokeObjectURL(videoUrl);videoUrl=null;videoOutstanding=0;}
function restartStream(){const active=cast;cast=null;stopVideo();active?.close();if(!closed&&!document.hidden&&inViewport)setTimeout(openCast,150);}
function fallbackVideo(){metrics.transport='jpeg';videoMode=false;restartStream();}
function setResponsiveTransport(enabled){const next=videoAvailable&&(!enabled||devtoolsSurface);if(videoMode===next)return;videoMode=next;restartStream();}
function openVideo(){
  if(!('VideoDecoder' in window)){videoMode=false;openCast();return;}
  videoUrl=URL.createObjectURL(new Blob([${JSON.stringify(videoWorker)}],{type:'text/javascript'}));
  const worker=videoWorker=new Worker(videoUrl);
  const ws=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+location.pathname.replace(/\\/viewer$/,'/video')+'?id='+encodeURIComponent(id));
  ws.binaryType='arraybuffer';cast=ws;
  const ack=()=>{videoOutstanding=Math.max(0,videoOutstanding-1);if(ws.readyState===1)ws.send('ack');};
  worker.onmessage=e=>{const result=e.data;if(videoWorker!==worker){result.frame?.close();return;}if(result.error){fallbackVideo();return;}const frame=result.frame;if(!frame)return;traceSample('decode',result.decodeMs);metrics.transport=metrics.relay==='binary'?'h264-binary':'h264-rpc';if(closed||document.hidden||!inViewport||videoWorker!==worker){frame.close();ack();return;}if(decodedFrame){decodedFrame.bitmap.close();decodedFrame.ack();metrics.dropped++;}decodedFrame={readyAt:performance.now(),bitmap:frame,frame:{width:result.width,height:result.height,url:currentUrl,loading:pageLoading},ack};if(!paintScheduled){paintScheduled=true;requestAnimationFrame(drawFrame);}};
  worker.onerror=()=>{if(videoWorker===worker)fallbackVideo();};
  ws.onmessage=e=>{if(cast!==ws||videoWorker!==worker)return;if(typeof e.data==='string'){try{const info=JSON.parse(e.data);if(info.error){fallbackVideo();return;}if(info.transport)metrics.relay=info.transport;if(info.hostVideo){traceSample('hostQueue',info.hostVideo.queueMs);traceSample('hostPacketGap',info.hostVideo.packetGapMs);}traceSample('videoAck',info.videoAckMs);if(info.url){currentUrl=info.url;if(document.activeElement!==address)address.value=info.url;}pageLoading=!!info.loading;renderCopy();}catch{}return;}if(videoOutstanding>=12){fallbackVideo();return;}videoOutstanding++;metrics.bytes+=e.data.byteLength;traceSample('receiveGap',lastSocketFrame?Date.now()-lastSocketFrame:0);lastSocketFrame=Date.now();worker.postMessage(e.data,[e.data]);};
  ws.onclose=()=>{if(cast===ws){cast=null;stopVideo();if(!closed&&!document.hidden&&inViewport)setTimeout(openCast,400);}};
  ws.onerror=()=>{if(cast===ws)fallbackVideo();};
}
`;
