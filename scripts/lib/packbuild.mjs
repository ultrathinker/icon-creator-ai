// The pack builder: turn one generated candidate PNG into a finished
// cross-platform icon pack (the export layout of the sibling `icon-creator`,
// same author, MIT, adapted for raster masters and "never upscale" rules).
//
// A candidate is prepared in memory — the flat background removed by flood
// fill, the subject fitted into a transparent square — and every pack file is
// a shrink of that master. Sizes above the master are omitted and listed, so
// nothing is silently enlarged.

import fs from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng, analyzeRgba } from './png.mjs';
import { buildIco } from './ico.mjs';
import { buildIcns } from './icns.mjs';
import { iconBackground, hexOf, appleInner, maskableInner, renderOnBackground, rimContrast } from './platform.mjs';
import { resizeArea, shrinkForIcon, cornerPixels, cornersUniform, borderBackground, meanColor, removeBackground } from './pixels.mjs';
import { tightFit, assertFill, DEFAULT_FILL, SOFT_ENLARGE } from './tightfit.mjs';

export const DEFAULT_TOLERANCE = 32;
export { DEFAULT_FILL };
export const WINDOWS_ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
export const MACOS_ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024];
export const LINUX_SIZES = [16, 22, 24, 32, 48, 64, 96, 128, 192, 256, 512];
export const WEB_PNG_SIZES = { 'apple-touch-icon.png': 180, 'icon-192.png': 192, 'icon-512.png': 512 };
export const FAVICON_ICO_SIZES = [16, 32, 48];
export const MANIFEST_ICON_SIZES = [192, 512];
export const MASKABLE_SIZE = 512;
/** An outline closer than this (WCAG contrast ratio) to a dark or a light background is reported as fading on it. */
export const MIN_EDGE_CONTRAST = 2;

export function sanitizeName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(
      `"${name}" is not a safe file name: use 1-64 characters from letters, digits, ".", "_", "-", ` +
        'starting with a letter or digit (no path separators, no spaces)',
    );
  }
  return name;
}

function titleOrDefault(name) {
  const spaced = name.replaceAll('-', ' ').replaceAll('_', ' ').replaceAll('.', ' ');
  return spaced
    .split(' ')
    .filter((word) => word.length > 0)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * The manifest lists only the icon files the pack really contains (`sizes` of 192 and 512, and the maskable 512 when
 * `maskable`). It carries what an installable web app needs besides icons: start_url, display and the two colours
 * (the icon's own background colour, so the splash screen and the address bar match the icon).
 */
export function webmanifestText(title, name, sizes = MANIFEST_ICON_SIZES, { maskable = false, color = null } = {}) {
  const label = String(title).replace(/[\r\n\t]+/g, ' ').trim();
  const manifest = {
    name: label,
    short_name: label.slice(0, 12),
    start_url: '/',
    display: 'standalone',
    ...(color === null ? {} : { background_color: color, theme_color: color }),
    icons: [
      ...sizes.map((size) => ({ src: `/icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' })),
      ...(maskable ? [{ src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }] : []),
    ],
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** The head snippet links only files the pack really contains. */
export function headHtmlText({ favicon = FAVICON_ICO_SIZES, apple = true, manifest = true, color = null } = {}) {
  const lines = [
    '<!-- Paste into the <head> of every page. Adjust the paths if the icons',
    '     do not live at the root of your site. -->',
  ];
  if (favicon.length > 0) lines.push(`<link rel="icon" href="/favicon.ico" sizes="${favicon.map((size) => `${size}x${size}`).join(' ')}">`);
  if (apple) lines.push('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
  if (manifest) lines.push('<link rel="manifest" href="/site.webmanifest">');
  if (color !== null) lines.push(`<meta name="theme-color" content="${color}">`);
  lines.push('');
  return lines.join('\n');
}

export function desktopEntryText(title, name) {
  return [
    `# ${name}.desktop — copy to ~/.local/share/applications/ (all users:`,
    '# /usr/share/applications/) and copy the hicolor/ tree next to your theme',
    '# icons (~/.local/share/icons/ or /usr/share/icons/). Adjust Exec to the',
    '# real command that starts the application.',
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${String(title).replace(/[\r\n\t]+/g, ' ').trim()}`,
    `Exec=${name}`,
    `Icon=${name}`,
    'Terminal=false',
    'Categories=Utility;',
    '',
  ].join('\n');
}

function percent(count, total) {
  return (100 * count) / total;
}

/**
 * Prepare one candidate PNG in memory: decide the background automatically
 * (already transparent -> keep; uniform opaque corners -> remove by flood
 * fill; anything else -> keep with a warning), then crop to the subject and refit it so
 * it fills `fill` of the longer side of a square master of the candidate's own longer side
 * (`crop: false` keeps the old centred, uncropped fit; `tile: 'keep'` leaves an opaque
 * tile whole; `background: 'keep'` skips the background removal because the user's prompt described the
 * background they wanted). Pure: no file access. Returns { size, rgba, png, facts, warnings }.
 */
export function prepareCandidate(buffer, { tolerance = DEFAULT_TOLERANCE, fill = DEFAULT_FILL, crop = true, tile = 'crop', background = 'auto' } = {}) {
  assertFill(fill);
  const decoded = decodePng(buffer);
  const { width, height } = decoded;
  const total = width * height;
  const corners = cornerPixels(decoded.rgba, width, height);
  const cornerAlphaBefore = corners.map((corner) => corner.a);
  const warnings = [];
  let action = 'keep';
  let reason = 'kept as is';
  let reference = null;
  const cornersTransparent = corners.every((corner) => corner.a <= 10);
  const keepBackground = background === 'keep';
  const cornersFlat = !keepBackground && !cornersTransparent && cornersUniform(corners, tolerance);
  // A subject that touches the image edge (even a corner) hides the flat background in some corners: the whole border decides then.
  const border = cornersTransparent || cornersFlat || keepBackground ? null : borderBackground(decoded.rgba, width, height, tolerance);
  if (cornersTransparent) {
    reason = 'the corners are already transparent';
  } else if (keepBackground) {
    reason = 'the prompt described its own background, so it was kept';
  } else if (cornersFlat) {
    action = 'remove';
    reason = 'the four corners are one uniform colour, so that colour is the background';
    reference = meanColor(corners);
  } else if (border !== null) {
    action = 'remove';
    reason = 'most of the image border is one uniform colour (the subject touches the edge), so that colour is the background';
    reference = border.reference;
  } else {
    reason = 'the background is not one flat colour (gradient or pattern?)';
    warnings.push({
      code: 'background-uncertain',
      message:
        'The background is not a flat colour, so it was kept and the icon keeps its background. ' +
        'Ask the model for a plain flat background, accept the icon as a filled tile, or, when the colour is flat but noisy ' +
        '(JPEG), rebuild with a higher --tolerance (for example 60).',
    });
  }

  let pixels = decoded.rgba;
  let transparent = 0;
  let softened = 0;
  if (action === 'remove') {
    const result = removeBackground(decoded.rgba, width, height, reference, tolerance);
    pixels = result.rgba;
    transparent = result.transparent;
    softened = result.softened;
  }

  // Crop to the subject and refit it into a square of the longer side; the legacy centred fit only when
  // cropping is off or nothing is visible.
  const tight = crop ? tightFit(pixels, width, height, { fill, tile }) : null;
  const cropped = tight !== null && tight.mode !== 'filled';
  const fit = cropped ? tight : fitIntoSquare(pixels, width, height);
  if (crop && tight === null) {
    warnings.push({
      code: 'nothing-visible',
      message: 'No visible pixel is left after background removal, so there was nothing to crop to. Check the candidate image.',
    });
  }

  const analysis = analyzeRgba(fit.size, fit.size, fit.rgba);
  const content = fit.content;
  if (cropped && tight.mode === 'tile') {
    warnings.push({
      code: 'tile-recropped',
      message:
        'The candidate is an opaque tile with the picture inside it. The crop went to the picture inside the tile, so the icon is now a ' +
        'full-square tile of that colour (a platform that rounds icons will round it). Pass --keep-tile to keep the tile as drawn.',
    });
  }
  if (cropped && tight.enlarge > SOFT_ENLARGE) {
    warnings.push({
      code: 'enlarged',
      message:
        `The subject filled only part of the generated image, so it was enlarged ${tight.enlarge.toFixed(1)}x to fill the square; ` +
        'the largest sizes look soft. Generate a "large" run, or ask for a bigger subject.',
    });
  }
  // The edge of the drawing against a dark and a light background: a shape that melts into one of them is said so.
  const contrast = rimContrast(fit.rgba, fit.size);
  if (contrast !== null && contrast.onDark < MIN_EDGE_CONTRAST) {
    warnings.push({
      code: 'fades-on-dark',
      message: `The edge of this icon is dark (contrast ${contrast.onDark.toFixed(1)}:1 against a dark background), so on a dark theme or taskbar the shape melts into it. Check the dark tile on the sheet.`,
    });
  }
  if (contrast !== null && contrast.onLight < MIN_EDGE_CONTRAST) {
    warnings.push({
      code: 'fades-on-light',
      message: `The edge of this icon is pale (contrast ${contrast.onLight.toFixed(1)}:1 against white), so on a light page the shape melts into it. Check the checkerboard tile on the sheet.`,
    });
  }
  const cornerAlphaAfter = analysis.cornerAlphas;
  if (!keepBackground && cornerAlphaAfter.some((alpha) => alpha > 10)) {
    warnings.push({
      code: 'opaque-corners',
      message:
        'The corners are still opaque after background removal, so the icon works as a filled tile ' +
        'but not as a transparent glyph.',
    });
  }
  if (fit.size < 256) {
    warnings.push({
      code: 'tiny-master',
      message:
        `The master is only ${fit.size} px; sizes above it were omitted and the largest exports will look soft. ` +
        'Generate a "large" run for a 1024 px master.',
    });
  }

  return {
    size: fit.size,
    rgba: fit.rgba,
    png: encodePng(fit.size, fit.size, fit.rgba),
    facts: {
      sourceWidth: width,
      sourceHeight: height,
      background: { action, reason, reference, tolerance },
      cornerAlphaBefore,
      cornerAlphaAfter,
      madeTransparentPercent: percent(transparent, total),
      softenedPercent: percent(softened, total),
      fit: {
        size: fit.size,
        content,
        crop:
          cropped
            ? { mode: tight.mode, fill, source: tight.source, window: tight.window, enlarge: tight.enlarge, ...(tight.tileColor === null ? {} : { tileColor: tight.tileColor }) }
            : { mode: crop ? (tight === null ? 'none' : 'filled') : 'off' },
      },
      ink: { visibleRatio: analysis.visibleRatio, bbox: analysis.bbox },
      contrast: contrast === null ? null : { onDark: contrast.onDark, onLight: contrast.onLight },
    },
    warnings,
  };
}

function fitIntoSquare(rgba, width, height) {
  const size = Math.max(width, height);
  if (width === height) {
    return { size, rgba, content: { x: 0, y: 0, width, height } };
  }
  const small = resizeArea(rgba, width, height, width < height ? width : size, width < height ? size : height);
  const contentWidth = width < height ? width : size;
  const contentHeight = width < height ? size : height;
  const canvas = Buffer.alloc(size * size * 4);
  const left = Math.floor((size - contentWidth) / 2);
  const top = Math.floor((size - contentHeight) / 2);
  for (let y = 0; y < contentHeight; y += 1) {
    small.copy(canvas, ((top + y) * size + left) * 4, y * contentWidth * 4, (y + 1) * contentWidth * 4);
  }
  return { size, rgba: canvas, content: { x: left, y: top, width: contentWidth, height: contentHeight } };
}

/**
 * Plan every file of one pack for a master of `masterSize` px: relative
 * paths, kinds and the sizes each needs. Sizes above the master are omitted
 * and returned in `omitted`. Pure.
 */
export function planPack(name, masterSize) {
  const files = [];
  const omitted = [];
  const fits = (size) => size <= masterSize;
  const above = (sizes) => sizes.filter((size) => !fits(size));
  files.push({ rel: `icon-${masterSize}.png`, kind: 'master', size: masterSize });
  // Every size that cannot be made is named: nothing a user might expect is dropped silently.
  const icoSizes = WINDOWS_ICO_SIZES.filter(fits);
  if (icoSizes.length > 0) {
    files.push({ rel: `windows/${name}.ico`, kind: 'ico', sizes: icoSizes });
    const dropped = above(WINDOWS_ICO_SIZES);
    if (dropped.length > 0) omitted.push(`windows/${name}.ico is missing the ${dropped.join(', ')} px entries (above the ${masterSize} px master)`);
  } else omitted.push(`windows/${name}.ico (needs at least 16 px)`);
  // The .icns holds every slice the master can honestly make (a 512 px draft gives 16..512; macOS accepts an .icns without
  // the 1024 px slice); the slices above the master are named. Below 256 px there is no useful .icns at all.
  if (fits(256)) {
    files.push({ rel: `macos/${name}.icns`, kind: 'icns', sizes: MACOS_ICNS_SIZES.filter(fits) });
    const droppedIcns = above(MACOS_ICNS_SIZES);
    if (droppedIcns.length > 0) omitted.push(`macos/${name}.icns is missing the ${droppedIcns.join(', ')} px slice${droppedIcns.length > 1 ? 's' : ''} (above the ${masterSize} px master; a "large" 1K run makes the full set)`);
  } else omitted.push(`macos/${name}.icns (needs a master of at least 256 px; this one is ${masterSize} px)`);
  const linuxSizes = LINUX_SIZES.filter(fits);
  for (const size of linuxSizes) files.push({ rel: `linux/hicolor/${size}x${size}/apps/${name}.png`, kind: 'png', size });
  const linuxDropped = above(LINUX_SIZES);
  if (linuxDropped.length > 0) omitted.push(`linux/hicolor is missing ${linuxDropped.map((size) => `${size}x${size}`).join(', ')} (above the ${masterSize} px master)`);
  // The desktop entry names an icon of the hicolor tree; with none there it would point at nothing.
  if (linuxSizes.length > 0) files.push({ rel: `linux/${name}.desktop`, kind: 'desktop' });
  else omitted.push(`linux/${name}.desktop (no hicolor icon fits this ${masterSize} px master, so it would name an icon that does not exist)`);
  const faviconSizes = FAVICON_ICO_SIZES.filter(fits);
  if (faviconSizes.length > 0) {
    files.push({ rel: 'web/favicon.ico', kind: 'ico', sizes: faviconSizes });
    const dropped = above(FAVICON_ICO_SIZES);
    if (dropped.length > 0) omitted.push(`web/favicon.ico is missing the ${dropped.join(', ')} px entries (above the ${masterSize} px master)`);
  } else omitted.push('web/favicon.ico (needs at least 16 px)');
  for (const [file, size] of Object.entries(WEB_PNG_SIZES)) {
    // The apple-touch icon is its own rendering (opaque, with a margin), not the master smaller.
    if (fits(size)) files.push({ rel: `web/${file}`, kind: file === 'apple-touch-icon.png' ? 'apple' : 'png', size });
    else omitted.push(`web/${file} (needs ${size} px)`);
  }
  // The maskable icon (opaque, the picture inside the safe zone) is a separate 512 px file.
  if (fits(MASKABLE_SIZE)) files.push({ rel: `web/icon-maskable-${MASKABLE_SIZE}.png`, kind: 'maskable', size: MASKABLE_SIZE });
  else omitted.push(`web/icon-maskable-${MASKABLE_SIZE}.png (needs ${MASKABLE_SIZE} px)`);
  // The manifest and the head snippet reference the web icons, so they list only the ones that exist,
  // and are left out (and said so) when there is nothing for them to reference.
  const manifestSizes = MANIFEST_ICON_SIZES.filter(fits);
  if (manifestSizes.length > 0) files.push({ rel: 'web/site.webmanifest', kind: 'webmanifest', sizes: manifestSizes, maskable: fits(MASKABLE_SIZE) });
  else omitted.push(`web/site.webmanifest (it lists the ${MANIFEST_ICON_SIZES.join(' and ')} px icons; this master is ${masterSize} px)`);
  const head = { favicon: faviconSizes, apple: fits(WEB_PNG_SIZES['apple-touch-icon.png']), manifest: manifestSizes.length > 0 };
  if (head.favicon.length > 0 || head.apple || head.manifest) files.push({ rel: 'web/head.html', kind: 'head', ...head });
  else omitted.push('web/head.html (no web icon exists for it to link)');
  return { files, omitted };
}

/** Render the prepared master at `size` px (a shrink; the small sizes get a light sharpening, see shrinkForIcon). */
export function renderSize(prepared, size, { sharpen = true } = {}) {
  if (size > prepared.size) throw new Error(`internal error: asked for ${size} px from a ${prepared.size} px master`);
  if (size === prepared.size) return prepared.png;
  return encodePng(size, size, shrinkForIcon(prepared.rgba, prepared.size, size, { sharpen }));
}

/**
 * Write one pack folder. `publish(rel, buffer)` receives every file; the CLI
 * passes a link-safe writer. Files are written one by one as each is made: a failure midway leaves the pack unfinished,
 * and building it again needs --variant or --force.
 */
export function buildPack(prepared, { name, publish, title = null, sharpen = true }) {
  const safeName = sanitizeName(name);
  const safeTitle = title ?? titleOrDefault(safeName);
  const { files, omitted } = planPack(safeName, prepared.size);
  const written = [];
  let backgroundColor = null;
  const background = () => (backgroundColor ??= iconBackground(prepared));
  for (const file of files) {
    let buffer;
    switch (file.kind) {
      case 'master':
      case 'png':
        buffer = renderSize(prepared, file.size, { sharpen });
        break;
      case 'ico':
        buffer = buildIco(file.sizes.map((size) => ({ size, png: renderSize(prepared, size, { sharpen }) })));
        break;
      case 'icns': {
        const bySize = new Map(file.sizes.map((size) => [size, renderSize(prepared, size, { sharpen })]));
        buffer = buildIcns(bySize);
        break;
      }
      case 'apple':
        buffer = renderOnBackground(prepared, file.size, appleInner(file.size), background());
        break;
      case 'maskable':
        buffer = renderOnBackground(prepared, file.size, maskableInner(prepared, file.size), background());
        break;
      case 'webmanifest':
        buffer = Buffer.from(webmanifestText(safeTitle, safeName, file.sizes, { maskable: file.maskable, color: hexOf(background()) }), 'utf8');
        break;
      case 'head':
        buffer = Buffer.from(headHtmlText({ favicon: file.favicon, apple: file.apple, manifest: file.manifest, color: file.manifest ? hexOf(background()) : null }), 'utf8');
        break;
      case 'desktop':
        buffer = Buffer.from(desktopEntryText(safeTitle, safeName), 'utf8');
        break;
      default:
        throw new Error(`internal error: unknown file kind ${file.kind}`);
    }
    publish(file.rel, buffer);
    written.push({ rel: file.rel, bytes: buffer.length });
  }
  return { name: safeName, title: safeTitle, masterSize: prepared.size, files: written, omitted };
}

/**
 * Publish a file inside a pack folder: refuse a symbolic link at the target,
 * then write through an exclusively created staging entry that is renamed
 * over the target, so a planted alias can never redirect the bytes.
 */
export function publishPackFile(absolute, buffer) {
  let stat = null;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    stat = null;
  }
  if (stat !== null && stat.isSymbolicLink()) {
    throw new Error(`${absolute} is a symbolic link: refusing to write through it`);
  }
  const staged = `${absolute}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const fd = fs.openSync(staged, 'wx');
  try {
    fs.writeFileSync(fd, buffer);
    fs.closeSync(fd);
    fs.renameSync(staged, absolute);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
    fs.rmSync(staged, { force: true });
    throw error;
  }
}

/** Create `dirPath` if missing, refusing symbolic links in the chain. */
export function ensureRealDir(dirPath) {
  const absolute = path.resolve(dirPath);
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat = null;
    try {
      stat = fs.lstatSync(current);
    } catch {
      stat = null;
    }
    if (stat !== null) {
      if (stat.isSymbolicLink()) {
        throw new Error(`${current} is a symbolic link or junction: refusing to follow it`);
      }
      if (!stat.isDirectory()) throw new Error(`${current} exists and is not a directory`);
    } else {
      fs.mkdirSync(current);
    }
  }
  return current;
}
