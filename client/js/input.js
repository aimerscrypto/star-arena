// Keyboard + mouse state.
const { BTN } = window.Shared;

const KEYMAP = {
  KeyW: BTN.UP, ArrowUp: BTN.UP,
  KeyS: BTN.DOWN, ArrowDown: BTN.DOWN,
  KeyA: BTN.LEFT, ArrowLeft: BTN.LEFT,
  KeyD: BTN.RIGHT, ArrowRight: BTN.RIGHT,
  Space: BTN.FIRE,
};

export class Input {
  constructor(canvas) {
    this.keys = 0;
    this.mouseDown = false;
    this.mouseX = innerWidth / 2;
    this.mouseY = innerHeight / 2;
    this.mouseMoved = false;
    this.enabled = false;       // only capture game keys while playing
    this.onToggleStats = null;
    this.onToggleMute = null;

    const typing = () => document.activeElement && document.activeElement.tagName === 'INPUT';

    addEventListener('keydown', (e) => {
      if (e.code === 'Tab') {
        if (this.enabled || !typing()) {
          e.preventDefault();
          if (!e.repeat && this.onToggleStats) this.onToggleStats();
        }
        return;
      }
      if (e.code === 'KeyM' && !typing()) {
        if (!e.repeat && this.onToggleMute) this.onToggleMute();
        return;
      }
      if (!this.enabled) return;
      const b = KEYMAP[e.code];
      if (b) { this.keys |= b; e.preventDefault(); }
    });
    addEventListener('keyup', (e) => {
      const b = KEYMAP[e.code];
      if (b) this.keys &= ~b;
    });
    addEventListener('blur', () => { this.keys = 0; this.mouseDown = false; });

    canvas.addEventListener('pointermove', (e) => {
      this.mouseX = e.clientX; this.mouseY = e.clientY; this.mouseMoved = true;
    });
    canvas.addEventListener('pointerdown', (e) => { if (e.button === 0) this.mouseDown = true; });
    addEventListener('pointerup', (e) => { if (e.button === 0) this.mouseDown = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  buttons() {
    if (!this.enabled) return 0;
    return this.keys | (this.mouseDown ? BTN.FIRE : 0);
  }
}
