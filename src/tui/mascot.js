// Mascot — pimg container-bot. Pure ASCII (never tofu, never mojibake) in
// every icon set; mood + blink frame keep it alive like a buddy, not a logo.
// mascotLines() is pure + width-bounded so the header can never break.
import React from 'react';
import { Box, Text } from 'ink';

export const MASCOT_WIDTH = 9;
export const MASCOT_HEIGHT = 4;

const BODY = ['  .---.  ', '  |[=]|  ', "  '---'  "];

export function mascotLines(mood = 'idle', tick = 0) {
  const face =
    mood === 'done' ? '  |^_^|  '
    : mood === 'working' ? (tick % 2 === 0 ? '  |o_O|  ' : '  |O_o|  ')
    : '  |o_o|  ';
  // Antenna blink is drawn onto the top body line to keep a fixed 4 rows.
  const top =
    mood === 'working'
      ? (tick % 2 === 0 ? '~ .---.  ' : '  .---. ~')
      : BODY[0];
  return [top, face, BODY[1], BODY[2]];
}

export function Mascot({ mood = 'idle', tick = 0, bodyColor, eyeColor }) {
  const h = React.createElement;
  const [top, face, ribs, base] = mascotLines(mood, tick);
  return h(Box, { flexDirection: 'column' },
    h(Text, { key: 't', color: bodyColor }, top),
    h(Text, { key: 'f', color: eyeColor || bodyColor }, face),
    h(Text, { key: 'r', color: bodyColor }, ribs),
    h(Text, { key: 'b', color: bodyColor }, base));
}
