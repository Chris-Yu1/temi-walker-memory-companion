import { Injectable, signal } from '@angular/core';

type PendingMessage = {
  topic: string;
  type: string;
  data: string;
};

type PendingSubscription = {
  topic: string;
  type: string;
  options: SubscribeOptions;
};

type SubscribeOptions = {
  throttleRate?: number;
  queueLength?: number;
};

type WalkerWindow = Window & {
  __env?: {
    BACKEND_URL?: string;
    ROSBRIDGE_PORT?: string;
  };
};

@Injectable({ providedIn: 'root' })
export class WalkerRosBridgeService {
  private socket: WebSocket | null = null;
  private queue: PendingMessage[] = [];
  private subscriptionQueue: PendingSubscription[] = [];
  private activeSubscriptions = new Set<string>();
  private connectPromise: Promise<void> | null = null;
  private activeUrl = '';
  private talking = false;
  private sawTalkingState = false;
  private lightFlashTimer?: number;
  private lastCameraFrameAt = 0;

  readonly connected = signal(false);
  readonly lastEvent = signal('');
  readonly cameraFrame = signal('');

  connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)) {
      return;
    }

    this.connectPromise = this.connectToFirstAvailableBridge();
  }

  publishToLights(message: string): void {
    for (const command of this.toWalkerLightCommands(message)) {
      this.publish('/lights/str', 'std_msgs/String', command);
    }
  }

  startCameraStream(): void {
    this.connect();
    this.subscribe('/usb_cam/image_raw/compressed', 'sensor_msgs/CompressedImage', {
      throttleRate: 80,
      queueLength: 1
    });
  }

  async say(text: string): Promise<void> {
    if (!text.trim()) return;
    this.connect();
    await this.waitForConnection();
    if (!this.isConnected()) {
      throw new Error(this.lastEvent() || 'Walker ROS bridge is not connected.');
    }

    this.startSpeakingLightFlash();
    try {
      this.publish('/say', 'std_msgs/String', text.trim());
      await this.waitForSpeechToFinish(text);
    } finally {
      this.stopSpeakingLightFlash();
    }
  }

  async testSpeakerAndLights(): Promise<void> {
    await this.say('Walker speaker and lights are connected.');
  }

  private publish(topic: string, type: string, data: string): void {
    const message = { topic, type, data };
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.queue.push(message);
      this.connect();
      return;
    }

    this.socket.send(JSON.stringify({
      op: 'publish',
      topic,
      msg: { data }
    }));
  }

  private advertise(topic: string, type: string): void {
    this.socket?.send(JSON.stringify({ op: 'advertise', topic, type }));
  }

  private subscribe(topic: string, type: string, options: SubscribeOptions = {}): void {
    const key = `${topic}:${type}`;
    if (this.activeSubscriptions.has(key)) {
      return;
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.subscriptionQueue.push({ topic, type, options });
      this.connect();
      return;
    }

    this.activeSubscriptions.add(key);
    this.socket.send(JSON.stringify({
      op: 'subscribe',
      topic,
      type,
      ...(options.throttleRate !== undefined ? { throttle_rate: options.throttleRate } : {}),
      ...(options.queueLength !== undefined ? { queue_length: options.queueLength } : {})
    }));
  }

  private flushQueue(): void {
    const pending = [...this.queue];
    this.queue = [];
    pending.forEach((message) => this.publish(message.topic, message.type, message.data));

    const pendingSubscriptions = [...this.subscriptionQueue];
    this.subscriptionQueue = [];
    pendingSubscriptions.forEach((subscription) =>
      this.subscribe(subscription.topic, subscription.type, subscription.options)
    );
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const message = JSON.parse(String(event.data)) as { topic?: string; msg?: { data?: boolean | string; format?: string } };
      if (message.topic === '/talking') {
        this.sawTalkingState = true;
        this.talking = message.msg?.data === true;
      } else if (message.topic === '/usb_cam/image_raw/compressed' && typeof message.msg?.data === 'string') {
        const now = performance.now();
        if (!this.cameraFrame() || now - this.lastCameraFrameAt >= 80) {
          this.lastCameraFrameAt = now;
          this.cameraFrame.set(`data:image/jpeg;base64,${message.msg.data}`);
        }
      }
    } catch {
      // Ignore malformed bridge messages.
    }
  }

  private async waitForSpeechToFinish(text: string): Promise<void> {
    const fallbackMs = this.estimateSpeechDurationMs(text);
    const startedAt = Date.now();
    let observedTalking = false;
    while (Date.now() - startedAt < fallbackMs) {
      await this.delay(150);
      observedTalking = observedTalking || this.talking;
      if (this.sawTalkingState && observedTalking && !this.talking && Date.now() - startedAt > 500) {
        return;
      }
    }
  }

  private startSpeakingLightFlash(): void {
    this.stopSpeakingLightFlash();
    this.publishToLights('go');
    this.lightFlashTimer = window.setInterval(() => {
      this.publishToLights('go');
    }, 1000);
  }

  private stopSpeakingLightFlash(): void {
    if (this.lightFlashTimer) {
      window.clearInterval(this.lightFlashTimer);
      this.lightFlashTimer = undefined;
    }
    if (this.isConnected()) {
      this.publishToLights('off');
    }
  }

  private estimateSpeechDurationMs(text: string): number {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1200, Math.min(14_000, words * 430 + 700));
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  private async waitForConnection(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }
    await this.connectPromise;
  }

  private isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private async connectToFirstAvailableBridge(): Promise<void> {
    const candidates = this.getRosBridgeCandidates();
    this.lastEvent.set(`Searching Walker ROS bridge: ${candidates.join(', ')}`);

    for (const url of candidates) {
      const socket = await this.tryOpenSocket(url);
      if (!socket) {
        continue;
      }

      this.socket = socket;
      this.activeUrl = url;
      this.connected.set(true);
      this.lastEvent.set(`Connected to Walker ROS bridge at ${url}`);
      this.advertise('/lights/str', 'std_msgs/String');
      this.advertise('/say', 'std_msgs/String');
      this.subscribe('/talking', 'std_msgs/Bool');
      await this.delay(120);
      this.socket.onmessage = (event) => this.handleMessage(event);
      this.socket.onclose = () => {
        this.connected.set(false);
        this.activeSubscriptions.clear();
        this.lastEvent.set(`Walker ROS bridge disconnected from ${this.activeUrl}`);
      };
      this.flushQueue();
      return;
    }

    this.connected.set(false);
    this.lastEvent.set(`Walker ROS bridge not found. Tried: ${candidates.join(', ')}`);
  }

  private tryOpenSocket(url: string): Promise<WebSocket | null> {
    return new Promise((resolve) => {
      let settled = false;
      let socket: WebSocket;
      const finish = (result: WebSocket | null): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        if (!result) {
          try {
            socket.close();
          } catch {
            // Ignore cleanup failures.
          }
        }
        resolve(result);
      };

      const timeout = window.setTimeout(() => finish(null), 900);
      try {
        socket = new WebSocket(url);
        socket.onopen = () => finish(socket);
        socket.onerror = () => finish(null);
        socket.onclose = () => {
          if (!settled) finish(null);
        };
      } catch {
        window.clearTimeout(timeout);
        resolve(null);
      }
    });
  }

  private getRosBridgeCandidates(): string[] {
    const params = new URLSearchParams(window.location.search);
    const explicitIp = params.get('ros_ip');
    const explicitPort = params.get('ros_port');
    const explicitPorts = params.get('ros_ports');
    const env = (window as WalkerWindow).__env;
    const envIp = env?.BACKEND_URL;
    const envPort = env?.ROSBRIDGE_PORT;
    const savedIp = window.localStorage.getItem('walker-ros-ip');
    const savedPort = window.localStorage.getItem('walker-ros-port');
    const ips = [
      explicitIp,
      savedIp,
      envIp,
      '192.168.4.1',
      window.location.hostname,
      'localhost',
      '127.0.0.1'
    ].filter((value): value is string => Boolean(value));
    const ports = [
      explicitPort,
      envPort,
      savedPort,
      ...(explicitPorts ? explicitPorts.split(',') : []),
      '9090',
      '9091',
      '3000',
      '4200',
      '8080',
      '8000'
    ].filter((value): value is string => Boolean(value));

    const candidates: string[] = [];
    for (const ip of unique(ips)) {
      for (const port of unique(ports)) {
        candidates.push(`ws://${ip}:${port}`);
      }
    }
    return unique(candidates);
  }

  private toWalkerLightCommands(message: string): string[] {
    const normalized = message.toLowerCase().trim();
    if (normalized === 'off') return ['left,1,1,1,0', 'right,1,1,1,0'];
    if (normalized === 'warning') return ['left,180,110,0,170', 'right,180,110,0,170'];
    return ['left,40,180,120,220', 'right,40,180,120,220'];
  }
}

function unique(values: string[]): string[] {
  return values.filter((value, index, array) => array.indexOf(value) === index);
}
