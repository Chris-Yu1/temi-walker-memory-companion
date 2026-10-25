import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, ElementRef, EventEmitter, OnDestroy, Output, ViewChild, inject, signal } from '@angular/core';
import { CalibrationValues, RobotService } from '../../services/robot.service';
import { SpeakerService } from '../../services/speaker.service';
import { WalkerRosBridgeService } from '../../services/walker-ros-bridge.service';

type BrowserFaceDetector = {
  detect(source: CanvasImageSource): Promise<Array<{ boundingBox: FaceBox }>>;
};

type FaceBox = Pick<DOMRectReadOnly, 'x' | 'y' | 'width' | 'height'>;

type NativeFaceResult = {
  detected: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

type TemiVisionBridge = {
  detectFace(base64Image: string): string;
};

type TemiMotionBridge = {
  lock?: () => string;
};

class NativeTemiFaceDetector implements BrowserFaceDetector {
  constructor(private readonly bridge: TemiVisionBridge) {}

  async detect(source: CanvasImageSource): Promise<Array<{ boundingBox: FaceBox }>> {
    if (!(source instanceof HTMLCanvasElement)) {
      return [];
    }

    const { canvas: detectionCanvas, scale } = this.createDetectionCanvas(source);
    const response = this.bridge.detectFace(detectionCanvas.toDataURL('image/jpeg', 0.55));
    const result = JSON.parse(response) as NativeFaceResult;
    if (!result.detected || result.x === undefined || result.y === undefined || result.width === undefined || result.height === undefined) {
      return [];
    }

    return [{
      boundingBox: {
        x: result.x / scale,
        y: result.y / scale,
        width: result.width / scale,
        height: result.height / scale
      }
    }];
  }

  private createDetectionCanvas(source: HTMLCanvasElement): { canvas: HTMLCanvasElement; scale: number } {
    const maxWidth = 480;
    const scale = Math.min(1, maxWidth / Math.max(source.width, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const context = canvas.getContext('2d');
    context?.drawImage(source, 0, 0, canvas.width, canvas.height);
    return { canvas, scale };
  }
}

class HeuristicFaceDetector implements BrowserFaceDetector {
  async detect(source: CanvasImageSource): Promise<Array<{ boundingBox: FaceBox }>> {
    if (!(source instanceof HTMLCanvasElement)) {
      return [];
    }

    const context = source.getContext('2d', { willReadFrequently: true });
    if (!context) return [];

    const step = Math.max(4, Math.round(Math.max(source.width, source.height) / 160));
    const image = context.getImageData(0, 0, source.width, source.height);
    let minX = source.width;
    let minY = source.height;
    let maxX = 0;
    let maxY = 0;
    let count = 0;

    for (let y = 0; y < source.height; y += step) {
      for (let x = 0; x < source.width; x += step) {
        const index = (y * source.width + x) * 4;
        const r = image.data[index];
        const g = image.data[index + 1];
        const b = image.data[index + 2];
        const maxChannel = Math.max(r, g, b);
        const minChannel = Math.min(r, g, b);
        const looksLikeSkin = r > 65 && g > 38 && b > 24 && maxChannel - minChannel > 12 && r > g && r > b;
        if (!looksLikeSkin) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        count += 1;
      }
    }

    const width = maxX - minX;
    const height = maxY - minY;
    const minPixels = Math.max(18, (source.width * source.height) / (step * step) * 0.01);
    if (count < minPixels || width < source.width * 0.08 || height < source.height * 0.12) {
      return [];
    }

    return [{
      boundingBox: {
        x: Math.max(0, minX - width * 0.15),
        y: Math.max(0, minY - height * 0.2),
        width: Math.min(source.width - minX, width * 1.3),
        height: Math.min(source.height - minY, height * 1.35)
      }
    }];
  }
}

@Component({
  selector: 'app-calibration',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './calibration.component.html',
  styleUrl: './calibration.component.scss'
})
export class CalibrationComponent implements AfterViewInit, OnDestroy {
  private readonly speakerService = inject(SpeakerService);
  private readonly robotService = inject(RobotService);
  private readonly walkerRosBridge = inject(WalkerRosBridgeService);
  @Output() readonly calibrated = new EventEmitter<CalibrationValues>();
  @Output() readonly back = new EventEmitter<void>();

  @ViewChild('videoElement') private videoElement?: ElementRef<HTMLVideoElement>;
  @ViewChild('rosCameraImage') private rosCameraImage?: ElementRef<HTMLImageElement>;
  @ViewChild('snapshotCanvas') private snapshotCanvas?: ElementRef<HTMLCanvasElement>;

  private stream?: MediaStream;
  private detector?: BrowserFaceDetector;
  private animationFrame?: number;
  private motionLockTimer?: number;
  private completionPromptSpoken = false;
  private lastSampleAt = 0;
  private lastSaveAttemptAt = 0;
  private readonly samples: CalibrationValues[] = [];
  private readonly sampleTarget = 50;
  private readonly minSampleIntervalMs = 60;

  readonly cameraReady = signal(false);
  readonly faceAligned = signal(false);
  readonly isLocking = signal(false);
  readonly sampleCount = signal(0);
  readonly latestValues = signal<CalibrationValues | null>(null);
  readonly snapshotPreview = signal('');
  readonly walkerCameraFrame = this.walkerRosBridge.cameraFrame;
  readonly message = signal('Please place your face inside the frame. Calibration starts automatically.');
  readonly error = signal('');

  ngAfterViewInit(): void {
    this.message.set('Please place your face inside the frame. Calibration starts automatically.');
    this.speakerService.prefetchText('Calibration measurement is complete. Please select Continue to go to the next page.', 'en-GB');
    this.startMotionLock();
    if (this.isWalkerRobot()) {
      void this.startCamera();
      return;
    }
    window.setTimeout(() => void this.startCamera(), 250);
  }

  ngOnDestroy(): void {
    this.clearMotionLock();
    this.stopCamera();
  }

  async startCamera(): Promise<void> {
    this.error.set('');
    this.lockTemiMotion();
    this.stopCamera();
    this.samples.length = 0;
    this.completionPromptSpoken = false;
    this.sampleCount.set(0);
    this.latestValues.set(null);
    this.snapshotPreview.set('');
    this.faceAligned.set(false);
    this.cameraReady.set(false);

    if (this.isWalkerRobot()) {
      this.startWalkerRosCamera();
      return;
    }

    try {
      const stream = await this.openEmbeddedCamera();
      this.stream = stream;
      const video = this.videoElement?.nativeElement;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      await this.waitForRealVideoFrame(video);
      this.cameraReady.set(true);
      this.message.set('Live camera is on. Keep your face centred and stay still.');
      this.startEmbeddedFrameSampling();
    } catch (error) {
      const detail = this.describeCameraError(error);
      this.cameraReady.set(false);
      this.faceAligned.set(false);
      this.sampleCount.set(0);
      this.error.set(`Embedded camera preview is unavailable: ${detail}`);
      this.message.set('Check camera permission, then return to this page.');
    }
  }

  saveCalibration(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    const now = performance.now();
    if (now - this.lastSaveAttemptAt < 900) {
      return;
    }
    this.lastSaveAttemptAt = now;
    if (this.isLocking()) {
      return;
    }

    if (!this.cameraReady() || this.samples.length < this.sampleTarget) {
      this.error.set('Please wait until calibration measurement is complete before continuing.');
      return;
    }

    this.isLocking.set(true);
    this.error.set('');
    this.message.set('Preparing the upload page...');
    this.stopCamera();
    this.calibrated.emit(this.averageSamples());
    this.isLocking.set(false);
  }

  private async openEmbeddedCamera(): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not expose navigator.mediaDevices.getUserMedia.');
    }

    const preferredConstraints: MediaStreamConstraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'user' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    };

    try {
      return await navigator.mediaDevices.getUserMedia(preferredConstraints);
    } catch {
      return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    }
  }

  private waitForRealVideoFrame(video: HTMLVideoElement): Promise<void> {
    return new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const check = (): void => {
        if (video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          resolve();
          return;
        }

        if (performance.now() - startedAt > 5000) {
          reject(new Error('Camera permission was granted, but no live video frame was received.'));
          return;
        }

        window.requestAnimationFrame(check);
      };

      check();
    });
  }

  private describeCameraError(error: unknown): string {
    if (error instanceof DOMException) {
      const secure = window.isSecureContext ? 'secure context' : 'insecure context';
      return `${error.name}: ${error.message || 'camera request failed'} (${secure}, ${window.location.origin})`;
    }
    return error instanceof Error ? error.message : 'Camera access failed.';
  }

  private startEmbeddedFrameSampling(): void {
    this.detector = this.createFaceDetector();
    const FaceDetectorCtor = (window as unknown as {
      FaceDetector?: new (options?: { fastMode?: boolean; maxDetectedFaces?: number }) => BrowserFaceDetector;
    }).FaceDetector;
    const temiVision = (window as unknown as { TemiVision?: TemiVisionBridge }).TemiVision;
    if (!FaceDetectorCtor && !temiVision) {
      this.error.set('');
      this.message.set('Live camera is on. Please keep your face inside the frame.');
    } else if (!FaceDetectorCtor && temiVision) {
      this.error.set('');
      this.message.set('Live camera is on. Please keep your face inside the frame.');
    }

    const detect = async (): Promise<void> => {
      const video = this.videoElement?.nativeElement;
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        this.animationFrame = window.requestAnimationFrame(() => void detect());
        return;
      }

      try {
        const now = performance.now();
        if (now - this.lastSampleAt >= this.minSampleIntervalMs && this.samples.length < this.sampleTarget) {
          this.lastSampleAt = now;
          const snapshot = this.captureSnapshot(video);
          const sample = await this.estimateCalibrationFromSnapshot(snapshot);
          this.faceAligned.set(sample.aligned);

          if (sample.values) {
            this.samples.push(sample.values);
            this.latestValues.set(sample.values);
            this.sampleCount.set(this.samples.length);
          }
        }

        if (this.samples.length >= this.sampleTarget) {
          this.faceAligned.set(true);
          this.message.set('Calibration complete. Select Continue to go to the next page.');
          if (!this.completionPromptSpoken) {
            this.completionPromptSpoken = true;
            void this.speakerService.speakTextWithFallback('Calibration measurement is complete. Please select Continue to go to the next page.', 'en-GB');
          }
          return;
        }

        this.message.set(this.faceAligned()
          ? 'Measuring. Please keep still.'
          : 'Move the face into the centre frame.');
      } catch (error) {
        this.faceAligned.set(false);
        this.error.set(this.describeCameraError(error));
        this.message.set('Camera is on, but calibration sampling failed.');
        return;
      }

      this.animationFrame = window.requestAnimationFrame(() => void detect());
    };

    void detect();
  }

  private startWalkerRosCamera(): void {
    this.detector = new HeuristicFaceDetector();
    this.walkerRosBridge.startCameraStream();
    this.message.set('Live Walker camera is starting. Please keep your face inside the frame.');
    const startedAt = performance.now();

    const detect = async (): Promise<void> => {
      const image = this.rosCameraImage?.nativeElement;
      if (!image || !this.walkerCameraFrame() || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        if (this.walkerCameraFrame()) {
          this.cameraReady.set(true);
          this.message.set('Live Walker camera stream is loading. Please keep your face inside the frame.');
        } else if (performance.now() - startedAt > 3000) {
          this.message.set('Waiting for Walker camera stream. Please keep your face inside the frame.');
        }
        this.animationFrame = window.requestAnimationFrame(() => void detect());
        return;
      }

      this.cameraReady.set(true);
      this.error.set('');

      try {
        const now = performance.now();
        if (now - this.lastSampleAt >= this.minSampleIntervalMs && this.samples.length < this.sampleTarget) {
          this.lastSampleAt = now;
          const snapshot = this.captureSnapshotFromImage(image);
          const sample = await this.estimateCalibrationFromSnapshot(snapshot);
          this.faceAligned.set(sample.aligned);

          if (sample.values) {
            this.samples.push(sample.values);
            this.latestValues.set(sample.values);
            this.sampleCount.set(this.samples.length);
          }
        }

        if (this.samples.length >= this.sampleTarget) {
          this.faceAligned.set(true);
          this.message.set('Calibration complete. Select Continue to go to the next page.');
          if (!this.completionPromptSpoken) {
            this.completionPromptSpoken = true;
            void this.speakerService.speakTextWithFallback('Calibration measurement is complete. Please select Continue to go to the next page.', 'en-GB');
          }
          return;
        }

        this.message.set(this.faceAligned()
          ? 'Measuring. Please keep still.'
          : 'Move the face into the centre frame.');
      } catch (error) {
        this.faceAligned.set(false);
        this.error.set(this.describeCameraError(error));
        this.message.set('Walker camera is on, but calibration sampling failed.');
        return;
      }

      this.animationFrame = window.requestAnimationFrame(() => void detect());
    };

    void detect();
  }

  private createFaceDetector(): BrowserFaceDetector {
    const FaceDetectorCtor = (window as unknown as {
      FaceDetector?: new (options?: { fastMode?: boolean; maxDetectedFaces?: number }) => BrowserFaceDetector;
    }).FaceDetector;
    const temiVision = (window as unknown as { TemiVision?: TemiVisionBridge }).TemiVision;
    return FaceDetectorCtor
      ? new FaceDetectorCtor({ fastMode: true, maxDetectedFaces: 1 })
      : temiVision
        ? new NativeTemiFaceDetector(temiVision)
        : new HeuristicFaceDetector();
  }

  private captureSnapshot(video: HTMLVideoElement): HTMLCanvasElement {
    const canvas = this.snapshotCanvas?.nativeElement ?? document.createElement('canvas');
    const width = video.videoWidth || 640;
    const height = video.videoHeight || 360;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context?.drawImage(video, 0, 0, width, height);
    if (this.samples.length % 10 === 0) {
      this.snapshotPreview.set(canvas.toDataURL('image/jpeg', 0.62));
    }
    return canvas;
  }

  private captureSnapshotFromImage(image: HTMLImageElement): HTMLCanvasElement {
    const canvas = this.snapshotCanvas?.nativeElement ?? document.createElement('canvas');
    const width = image.naturalWidth || 640;
    const height = image.naturalHeight || 360;
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')?.drawImage(image, 0, 0, width, height);
    if (this.samples.length % 10 === 0) {
      this.snapshotPreview.set(canvas.toDataURL('image/jpeg', 0.62));
    }
    return canvas;
  }

  private async estimateCalibrationFromSnapshot(canvas: HTMLCanvasElement): Promise<{ aligned: boolean; values: CalibrationValues | null }> {
    if (!this.detector) {
      return { aligned: false, values: null };
    }

    const faces = await this.detector.detect(canvas);
    const face = faces[0]?.boundingBox;
    if (!face) {
      return { aligned: false, values: null };
    }

    const aligned = this.isFaceInsideTarget(face, canvas);
    return {
      aligned,
      values: aligned ? this.estimatePoseAndGaze(face, canvas) : null
    };
  }

  private isFaceInsideTarget(face: FaceBox, source: { width?: number; height?: number; videoWidth?: number; videoHeight?: number }): boolean {
    const width = source.videoWidth || source.width || 1;
    const height = source.videoHeight || source.height || 1;
    const target = {
      left: width * 0.34,
      right: width * 0.66,
      top: height * 0.2,
      bottom: height * 0.78
    };
    const faceCenterX = face.x + face.width / 2;
    const faceCenterY = face.y + face.height / 2;
    return faceCenterX >= target.left && faceCenterX <= target.right && faceCenterY >= target.top && faceCenterY <= target.bottom;
  }

  private estimatePoseAndGaze(face: FaceBox, source: { width?: number; height?: number; videoWidth?: number; videoHeight?: number }): CalibrationValues {
    const width = Math.max(source.videoWidth || source.width || 1, 1);
    const height = Math.max(source.videoHeight || source.height || 1, 1);
    const centerX = face.x + face.width / 2;
    const centerY = face.y + face.height / 2;
    const normalizedX = (centerX / width - 0.5) * 2;
    const normalizedY = (centerY / height - 0.5) * 2;
    const faceWidthRatio = face.width / width;
    const faceHeightRatio = face.height / height;
    return {
      head_pose: {
        yaw: Number((normalizedX * 30).toFixed(2)),
        pitch: Number((normalizedY * 20).toFixed(2)),
        roll: Number(((faceWidthRatio - faceHeightRatio * 0.78) * 25).toFixed(2))
      },
      eye_gaze: {
        x: Number((normalizedX * 12).toFixed(2)),
        y: Number((normalizedY * 12).toFixed(2))
      },
      samples: 1
    };
  }

  private averageSamples(): CalibrationValues {
    if (!this.samples.length) {
      return {
        head_pose: { yaw: 0, pitch: 0, roll: 0 },
        eye_gaze: { x: 0, y: 0 },
        samples: 0
      };
    }

    const total = this.samples.reduce((sum, sample) => ({
      head_pose: {
        yaw: sum.head_pose.yaw + sample.head_pose.yaw,
        pitch: sum.head_pose.pitch + sample.head_pose.pitch,
        roll: sum.head_pose.roll + sample.head_pose.roll
      },
      eye_gaze: {
        x: sum.eye_gaze.x + sample.eye_gaze.x,
        y: sum.eye_gaze.y + sample.eye_gaze.y
      },
      samples: sum.samples + 1
    }), {
      head_pose: { yaw: 0, pitch: 0, roll: 0 },
      eye_gaze: { x: 0, y: 0 },
      samples: 0
    });
    const count = this.samples.length;
    return {
      head_pose: {
        yaw: Number((total.head_pose.yaw / count).toFixed(2)),
        pitch: Number((total.head_pose.pitch / count).toFixed(2)),
        roll: Number((total.head_pose.roll / count).toFixed(2))
      },
      eye_gaze: {
        x: Number((total.eye_gaze.x / count).toFixed(2)),
        y: Number((total.eye_gaze.y / count).toFixed(2))
      },
      samples: count
    };
  }

  private stopCamera(): void {
    if (this.animationFrame) {
      window.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = undefined;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
  }

  private startMotionLock(): void {
    this.lockTemiMotion();
    this.motionLockTimer = window.setInterval(() => this.lockTemiMotion(), 800);
  }

  private clearMotionLock(): void {
    if (this.motionLockTimer) {
      window.clearInterval(this.motionLockTimer);
      this.motionLockTimer = undefined;
    }
  }

  private lockTemiMotion(): void {
    try {
      (window as unknown as { TemiMotion?: TemiMotionBridge }).TemiMotion?.lock?.();
    } catch {
      // Native temi locking is best-effort and should not block calibration.
    }
  }

  private isWalkerRobot(): boolean {
    return this.robotService.robotId().toLowerCase().includes('walker');
  }
}
