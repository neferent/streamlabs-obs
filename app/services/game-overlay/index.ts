import electron from 'electron';
import { Subject, Subscription } from 'rxjs';
import { delay, take } from 'rxjs/operators';
import overlay, { OverlayThreadStatus } from '@streamlabs/game-overlay';
import { Inject, InitAfter } from 'services/core';
import { LoginLifecycle, UserService } from 'services/user';
import { CustomizationService } from 'services/customization';
import { getPlatformService } from '../platforms';
import { WindowsService } from '../windows';
import { PersistentStatefulService } from 'services/core/persistent-stateful-service';
import { mutation } from 'services/core/stateful-service';
import { $t } from 'services/i18n';

const { BrowserWindow } = electron.remote;

interface IWindowProperties {
  chat: { position: IVec2; id: number };
  recentEvents: { position: IVec2; id: number };
}

export type GameOverlayState = {
  isEnabled: boolean;
  isShowing: boolean;
  isPreviewEnabled: boolean;
  previewMode: boolean;
  opacity: number;
  windowProperties: IWindowProperties;
};

@InitAfter('UserService')
@InitAfter('WindowsService')
export class GameOverlayService extends PersistentStatefulService<GameOverlayState> {
  @Inject() userService: UserService;
  @Inject() customizationService: CustomizationService;
  @Inject() windowsService: WindowsService;

  static defaultState: GameOverlayState = {
    isEnabled: false,
    isShowing: false,
    isPreviewEnabled: true,
    previewMode: false,
    opacity: 100,
    windowProperties: {
      chat: { position: null, id: null },
      recentEvents: { position: null, id: null },
    },
  };

  windows: {
    chat: Electron.BrowserWindow;
    recentEvents: Electron.BrowserWindow;
    // overlayControls: Electron.BrowserWindow;
  } = {} as any;

  previewWindows: {
    chat: Electron.BrowserWindow;
    recentEvents: Electron.BrowserWindow;
    // overlayControls: Electron.BrowserWindow;
  } = {} as any;

  overlayWindow: Electron.BrowserWindow;
  onWindowsReady: Subject<Electron.BrowserWindow> = new Subject<Electron.BrowserWindow>();
  onWindowsReadySubscription: Subscription;
  lifecycle: LoginLifecycle;

  commonWindowOptions = {};

  async initialize() {
    if (!this.state.isEnabled) return;

    this.lifecycle = await this.userService.withLifecycle({
      init: this.initializeOverlay,
      destroy: this.destroyOverlay,
      context: this,
    });
  }

  async initializeOverlay() {
    overlay.start();

    this.onWindowsReadySubscription = this.onWindowsReady
      .pipe(
        take(Object.keys(this.windows).length),
        delay(5000), // so recent events has time to load
      )
      .subscribe({ complete: () => this.createWindowOverlays() });

    this.assignCommonWindowOptions();
    this.createBrowserWindows();
    this.createPreviewWindows();
    await this.configureWindows();
  }

  assignCommonWindowOptions() {
    const [containerX, containerY] = this.getWindowContainerStartingPosition();
    this.commonWindowOptions = {
      backgroundColor: this.customizationService.themeBackground,
      show: false,
      frame: false,
      width: 300,
      height: 300,
      x: containerX,
      y: containerY,
      skipTaskbar: true,
      thickFrame: false,
      resizable: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, offscreen: true },
    };
  }

  createBrowserWindows() {
    this.windows.recentEvents = new BrowserWindow({
      ...this.commonWindowOptions,
      width: 600,
    });

    this.windows.chat = new BrowserWindow({
      ...this.commonWindowOptions,
      height: 600,
    });
  }

  createPreviewWindows() {
    this.previewWindows.recentEvents = this.windowsService.createOneOffWindowForOverlay({
      ...this.commonWindowOptions,
      width: 600,
      transparent: true,
      webPreferences: { offscreen: false },
      isFullScreen: true,
      componentName: 'OverlayPlaceholder',
      title: $t('Recent Events'),
    });

    this.previewWindows.chat = this.windowsService.createOneOffWindowForOverlay({
      ...this.commonWindowOptions,
      height: 600,
      transparent: true,
      webPreferences: { offscreen: false },
      isFullScreen: true,
      componentName: 'OverlayPlaceholder',
      title: $t('Chat'),
    });
  }

  async configureWindows() {
    Object.keys(this.windows).forEach((key: string) => {
      const win = this.windows[key];
      win.webContents.once('did-finish-load', () => this.onWindowsReady.next(win));

      const position = this.determineStartPosition(key);
      const size = key === 'chat' ? { width: 300, height: 600 } : { width: 600, height: 300 };
      win.setBounds({ ...position, ...size });
      this.previewWindows[key].setBounds({ ...position, ...size });
    });

    this.windows.recentEvents.loadURL(this.userService.recentEventsUrl());
    this.windows.chat.loadURL(
      await getPlatformService(this.userService.platform.type).getChatUrl(
        this.customizationService.isDarkTheme ? 'night' : 'day',
      ),
    );
  }

  determineStartPosition(window: string) {
    const pos = this.state.windowProperties[window].position;
    if (pos) {
      const display = electron.screen.getAllDisplays().find(display => {
        const bounds = display.bounds;
        const intBounds = pos.x > bounds.x && pos.y > bounds.y;
        const extBounds = pos.x < bounds.x + bounds.width && pos.y < bounds.y + bounds.height;
        return intBounds && extBounds;
      });

      if (display) return pos;
    }
    this.SET_WINDOW_POSITION(window, null);

    return this.defaultPosition(window);
  }

  resetPosition() {
    Object.keys(this.windows).forEach((key: string) => {
      const overlayId = this.state.windowProperties[key].id;
      if (!overlayId) return;

      this.SET_WINDOW_POSITION(key, null);
      const pos = this.defaultPosition(key);
      const size = key === 'chat' ? { width: 300, height: 600 } : { width: 600, height: 300 };

      this.windows[key].setBounds({ ...pos, ...size });
      this.previewWindows[key].setBounds({ ...pos, ...size });
      overlay.setPosition(overlayId, pos.x, pos.y, size.width, size.height);
    });
  }

  private defaultPosition(key: string) {
    const [containerX, containerY] = this.getWindowContainerStartingPosition();
    const x = key === 'recentEvents' ? containerX - 600 : containerX;

    return { x, y: containerY };
  }

  showOverlay() {
    overlay.show();
    this.TOGGLE_OVERLAY(true);

    // Force a refresh to trigger a paint event
    Object.values(this.windows).forEach(win => win.webContents.invalidate());
  }

  hideOverlay() {
    overlay.hide();
    this.TOGGLE_OVERLAY(false);
  }

  toggleOverlay() {
    if (overlay.getStatus() !== OverlayThreadStatus.Running || !this.state.isEnabled) {
      return;
    }

    if (this.state.previewMode) this.setPreviewMode(false);

    this.state.isShowing ? this.hideOverlay() : this.showOverlay();
  }

  isEnabled() {
    return this.state.isEnabled;
  }

  async setEnabled(shouldEnable: boolean = true) {
    const shouldStart = shouldEnable && !this.state.isEnabled;
    const shouldStop = !shouldEnable && this.state.isEnabled;

    if (shouldStart) await this.initializeOverlay();
    if (shouldStop) await this.destroyOverlay();

    this.SET_ENABLED(shouldEnable);
  }

  async setPreviewMode(previewMode: boolean) {
    if (this.state.isShowing) this.hideOverlay();
    if (!this.state.isEnabled) return;
    this.SET_PREVIEW_MODE(previewMode);
    if (previewMode) {
      Object.values(this.previewWindows).forEach(win => win.show());
    } else {
      Object.keys(this.previewWindows).forEach(async key => {
        const win: electron.BrowserWindow = this.previewWindows[key];
        const overlayId = this.state.windowProperties[key].id;

        const [x, y] = win.getPosition();
        this.SET_WINDOW_POSITION(key, { x, y });
        const { width, height } = win.getBounds();

        await overlay.setPosition(overlayId, x, y, width, height);
        win.hide();
      });
    }
  }

  setOverlayOpacity(percentage: number) {
    this.SET_OPACITY(percentage);
    if (!this.state.isEnabled) return;
    Object.keys(this.windows).forEach(key => {
      const overlayId = this.state.windowProperties[key].id;

      overlay.setTransparency(overlayId, percentage * 2.55);
    });
  }

  setPreviewEnabled(shouldEnable: boolean = true) {
    this.SET_PREVIEW_ENABLED(shouldEnable);
  }

  async destroy() {
    if (!this.lifecycle) return;
    await this.lifecycle.destroy();
  }

  async destroyOverlay() {
    if (this.state.isEnabled) {
      await overlay.stop();
      if (this.onWindowsReadySubscription) await this.onWindowsReadySubscription.unsubscribe();
      if (this.windows) await Object.values(this.windows).forEach(win => win.destroy());
      if (this.previewWindows) {
        await Object.values(this.previewWindows).forEach(win => win.destroy());
      }
    }
    this.SET_PREVIEW_MODE(false);
    this.TOGGLE_OVERLAY(false);
  }

  private createWindowOverlays() {
    Object.keys(this.windows).forEach((key: string) => {
      const win: electron.BrowserWindow = this.windows[key];
      const overlayId = overlay.addHWND(win.getNativeWindowHandle());

      if (overlayId === -1 || overlayId == null) {
        this.overlayWindow.hide();
        throw new Error('Error creating overlay');
      }

      this.SET_WINDOW_ID(key, overlayId);

      const position = this.getPosition(key, win);
      const { width, height } = win.getBounds();

      overlay.setPosition(overlayId, position.x, position.y, width, height);
      overlay.setTransparency(overlayId, this.state.opacity * 2.55);

      win.webContents.on('paint', (event, dirty, image) => {
        overlay.paintOverlay(overlayId, width, height, image.getBitmap());
      });
      win.webContents.setFrameRate(1);
    });
  }

  private getPosition(key: string, win: electron.BrowserWindow) {
    if (this.state.windowProperties[key].position) {
      return this.state.windowProperties[key].position;
    }
    const [x, y] = win.getPosition();
    return { x, y };
  }

  private getWindowContainerStartingPosition() {
    const display = this.windowsService.getMainWindowDisplay();

    return [display.workArea.height / 2 + 200, display.workArea.height / 2 - 300];
  }

  @mutation()
  private SET_PREVIEW_ENABLED(isEnabled: boolean) {
    this.state.isPreviewEnabled = isEnabled;
  }

  @mutation()
  private TOGGLE_OVERLAY(isShowing: boolean) {
    this.state.isShowing = isShowing;
  }

  @mutation()
  private SET_ENABLED(shouldEnable: boolean = true) {
    this.state.isEnabled = shouldEnable;
  }

  @mutation()
  private SET_PREVIEW_MODE(previewMode: boolean = true) {
    this.state.previewMode = previewMode;
  }

  @mutation()
  private SET_WINDOW_ID(window: string, id: number) {
    this.state.windowProperties[window].id = id;
  }

  @mutation()
  private SET_WINDOW_POSITION(window: string, position: IVec2) {
    this.state.windowProperties[window].position = position;
  }

  @mutation()
  private SET_OPACITY(val: number) {
    this.state.opacity = val;
  }
}
