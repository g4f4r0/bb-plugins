import { it, expect, vi } from "vitest";
import { SelkiesStream } from "../src/selkies";
import type WebSocket from "ws";
it("routes page input through the isolated display", async () => {
  const stream = new SelkiesStream();
  const send = vi.fn();
  stream["socket"] = {
    readyState: 1,
    send,
    terminate: vi.fn(),
  } as unknown as WebSocket;
  await stream.runInput("viewer", [
    {
      kind: "pointer",
      type: "down",
      x: 12.2,
      y: 24.8,
      button: "right",
      buttons: 2,
      clickCount: 1,
      modifiers: 0,
    },
    {
      kind: "pointer",
      type: "up",
      x: 12.2,
      y: 24.8,
      button: "right",
      buttons: 0,
      clickCount: 1,
      modifiers: 0,
    },
    { kind: "wheel", x: 12, y: 25, deltaX: 0, deltaY: 120, modifiers: 0 },
    { kind: "keyboard", type: "down", key: "Enter", code: "Enter", modifiers: 0, repeat: false },
    { kind: "keyboard", type: "up", key: "Enter", code: "Enter", modifiers: 0, repeat: false },
    { kind: "text", text: "hello, world" },
  ]);
  expect(send).toHaveBeenCalledWith("m,12,25,4,0");
  expect(send).toHaveBeenCalledWith("m,12,25,0,0");
  expect(send).toHaveBeenCalledWith("m,12,25,16,2");
  expect(send).toHaveBeenCalledWith("kd,65293");
  expect(send).toHaveBeenCalledWith("ku,65293");
  expect(send).toHaveBeenCalledWith("co,end,hello, world");
  await stream.stop();
});
it("discards stale delta frames and resumes only at a keyframe", async () => {
  const stream = new SelkiesStream();
  const send = vi.fn();
  stream["socket"] = { send, terminate: vi.fn() } as unknown as WebSocket;
  const packet = (id: number, key = false) => {
    const b = Buffer.alloc(11);
    b[0] = 4;
    b[1] = key ? 1 : 0;
    b.writeUInt16BE(id, 2);
    return b;
  };
  for (let i = 0; i < 8; i++) stream["enqueue"](packet(i, i === 0));
  stream["enqueue"](packet(8));
  stream["enqueue"](packet(9));
  expect(
    send.mock.calls.filter((c) => c[0] === "REQUEST_KEYFRAME"),
  ).toHaveLength(1);
  expect(stream["packets"]).toHaveLength(0);
  stream["enqueue"](packet(10, true));
  stream["enqueue"](packet(11));
  expect((await stream.readPackets()).map((b) => b.readUInt16BE(2))).toEqual([
    10, 11,
  ]);
  expect(send).toHaveBeenCalledWith("CLIENT_FRAME_ACK 9 0");
  await stream.stop();
});
it('retries recovery when the encoder is silent and clears the retry on stop',async()=>{
 vi.useFakeTimers();
 const stream=new SelkiesStream();const send=vi.fn();
 stream['socket']={send,terminate:vi.fn()} as unknown as WebSocket;
 try {
  for(let i=0;i<9;i++){const b=Buffer.alloc(11);b[0]=4;b.writeUInt16BE(i,2);stream['enqueue'](b);}
  await vi.advanceTimersByTimeAsync(550);
  expect(send.mock.calls.filter(c=>c[0]==='REQUEST_KEYFRAME')).toHaveLength(2);
  await stream.stop();const count=send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1100);expect(send).toHaveBeenCalledTimes(count);
 }finally{await stream.stop();vi.useRealTimers();}
});
it('schedules a throttled second recovery even if no more frames arrive',async()=>{
 vi.useFakeTimers();const stream=new SelkiesStream();const send=vi.fn();
 stream['socket']={send,terminate:vi.fn()} as unknown as WebSocket;
 const enqueue=(key=false)=>{const b=Buffer.alloc(11);b[0]=4;b[1]=key?1:0;stream['enqueue'](b);};
 try {
  for(let i=0;i<9;i++)enqueue();enqueue(true);
  for(let i=0;i<8;i++)enqueue();
  expect(send.mock.calls.filter(c=>c[0]==='REQUEST_KEYFRAME')).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(300);
  expect(send.mock.calls.filter(c=>c[0]==='REQUEST_KEYFRAME')).toHaveLength(2);
 }finally{await stream.stop();vi.useRealTimers();}
});
it('backs off repeated overload with cooldown and a stable minimum',async()=>{
 vi.useFakeTimers();const stream=new SelkiesStream();const send=vi.fn();
 stream['socket']={send,terminate:vi.fn()} as unknown as WebSocket;
 try {
  stream['noteOverload']();expect(send).not.toHaveBeenCalled();
  stream['noteOverload']();expect(send).toHaveBeenLastCalledWith('_arg_fps,24');
  for(let i=0;i<10;i++)stream['noteOverload']();expect(send).toHaveBeenCalledTimes(1);
  for(const expected of [20,15]){await vi.advanceTimersByTimeAsync(5000);stream['noteOverload']();stream['noteOverload']();expect(send).toHaveBeenLastCalledWith('_arg_fps,'+expected);}
  await vi.advanceTimersByTimeAsync(5000);stream['noteOverload']();stream['noteOverload']();expect(send).toHaveBeenCalledTimes(3);
 }finally{await stream.stop();vi.useRealTimers();}
});
it('only sends bounded live bitrate updates while the encoder is open', async () => {
 const stream = new SelkiesStream(); const send = vi.fn();
 stream['socket'] = {send, terminate: vi.fn()} as unknown as WebSocket;
 for(const invalid of [0,1999,4001,NaN,2500.5]) stream.setBitrate(invalid);
 expect(send).not.toHaveBeenCalled();
 stream.setBitrate(3000); expect(send).toHaveBeenCalledWith('vb,3000');
 await stream.stop(); stream.setBitrate(2000); expect(send).toHaveBeenCalledTimes(1);
});
