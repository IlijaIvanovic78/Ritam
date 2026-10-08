// Tastatura na telefonu prekriva dno ekrana, a donji sheet i toast-ovi su zakačeni baš za dno.
// Visina tastature (deo ekrana ispod vidljivog dela) ide u CSS promenljivu --kb na <html>,
// a vidljiva visina u --vvh (i klasa kb-open); ui.css time podiže sheet i toast-ove iznad tastature.

/** Manje od ovoga nije tastatura (npr. traka browsera koja se skuplja). */
const MIN_KEYBOARD_PX = 100;

export function initKeyboardInset() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement.style;
  let frame = 0;
  let last = '';

  const update = () => {
    frame = 0;
    // Uvećan prikaz (pinch zoom) takođe smanjuje vidljivi deo — to nije tastatura.
    const covered = vv.scale > 1.01 ? 0 : Math.round(window.innerHeight - vv.height - vv.offsetTop);
    const kb = covered >= MIN_KEYBOARD_PX ? covered : 0;
    const vvh = Math.round(vv.height);
    const key = kb > 0 ? `${kb}|${vvh}` : '';
    if (key === last) return;
    last = key;
    if (kb > 0) {
      root.setProperty('--kb', `${kb}px`);
      root.setProperty('--vvh', `${vvh}px`);
    } else {
      root.removeProperty('--kb');
      root.removeProperty('--vvh');
    }
    document.documentElement.classList.toggle('kb-open', kb > 0);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };

  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  update();
}
