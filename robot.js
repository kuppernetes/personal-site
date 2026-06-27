/* ============================================================================
   Little robot — a WebGL raymarched 3D companion.
   The robot is a real 3D signed-distance field (rounded-box head + side ear
   pods + antenna stalk + glowing ball) raymarched in a single full-screen
   shader. It has genuine surface normals, key/fill lighting with a moving
   specular, ambient occlusion, a fresnel rim + spectral iridescence (ported
   from the Lens Studio surface look), and it physically rotates its head to
   look toward the cursor. Eyes and the tool-call binary rain are projected
   onto the curved front face; status glyphs (wifi / "?" / wave / Zzz) hover
   above the head as a screen-space HUD. Vanilla, no build step.
   ========================================================================== */
(function () {
  "use strict";

  const VERT = `
    attribute vec2 a_pos;
    void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
  `;

  // GLSL ES 1.0 fragment shader. A single full-screen triangle drives a small
  // 3D raymarcher. Object space is centred on the robot; the head turns to
  // face u_look. uv.y is up, in [-0.5, 0.5] (vertical), wider on x.
  const FRAG = `
    precision highp float;

    uniform vec2  u_resolution;
    uniform float u_time;
    uniform vec2  u_look;          // head look direction, ~[-1, 1]
    uniform float u_hover;         // 0..1 hover intensity
    uniform float u_boop;          // 0..1 click "boop" reaction
    uniform float u_motion;        // 1 = animate, 0 = reduced motion
    uniform vec3  u_antenna;       // antenna / accent colour
    uniform vec2  u_eye_size;      // per-state eye half-extents
    uniform float u_eye_curve;     // per-state eye curvature
    uniform float u_eye_bright;    // per-state eye brightness (0 = off)
    uniform float u_pulse;         // per-state pulse speed
    uniform float u_bob;           // per-state bob amount
    uniform float u_error;         // 0..1 error (crossed-out eyes)
    uniform float u_wifi;          // 0..1 connecting accessory
    uniform float u_qm;            // 0..1 awaiting (question mark)
    uniform float u_wave;          // 0..1 listening (wave bars)
    uniform float u_zzz;           // 0..1 sleeping (Zs)
    uniform float u_tool;          // 0..1 tool call (binary rain)

    // ---- camera / layout tunables ------------------------------------------
    const float CAM_Z     = 6.0;   // camera distance (large = near-orthographic)
    const float FOCAL     = 2.7;   // larger = tighter / bigger robot
    const float CENTER_Y  = -0.16; // push robot down to leave HUD headroom
    const float YAW_AMT   = 0.38;  // head turn (radians) at full look.x
    const float PITCH_AMT = 0.28;  // head tilt (radians) at full look.y
    const float EYE_K     = 1.9;   // eye-size scale from 2D state values

    vec3 spectral(float t) {
      return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
    }

    float hash(float n) { return fract(n * 127.1 + n * n * 311.7); }

    float sdRoundBox3(vec3 p, vec3 b, float r) {
      vec3 q = abs(p) - b;
      return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
    }

    float sdRoundBox2(vec2 p, vec2 b, float r) {
      vec2 q = abs(p) - b;
      return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    }

    float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
      vec3 pa = p - a, ba = b - a;
      float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      return length(pa - ba * h) - r;
    }

    float sdSegment(vec2 p, vec2 a, vec2 b) {
      vec2 pa = p - a, ba = b - a;
      float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      return length(pa - ba * h);
    }

    float smin(float a, float b, float k) {
      float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
      return mix(b, a, h) - k * h * (1.0 - h);
    }

    // WebGL1 has no transpose()/inverse(); build rotations (and their inverses
    // via negated angles) by hand.
    mat3 rotX(float a) { float s = sin(a), c = cos(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
    mat3 rotY(float a) { float s = sin(a), c = cos(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }

    // A single binary glyph (a "0" dot-pair or a "1" bar) for the tool-call rain.
    float getBinaryBit(vec2 uv, float id) {
      float type = step(0.5, hash(id));
      vec2 p = uv * 2.0 - 1.0;
      float dotVal = smoothstep(0.12, 0.06, abs(p.x)) * smoothstep(0.85, 0.75, abs(p.y));
      float box = sdRoundBox2(p, vec2(0.35, 0.55), 0.1);
      float boxVal = smoothstep(0.1, 0.05, abs(box)) * step(-0.05, box);
      return mix(boxVal, dotVal, type);
    }

    // The robot as a 3D SDF in local space. Returns vec2(distance, materialId):
    //   1 = shell (head + ears + stalk), 2 = antenna ball.
    vec2 map(vec3 p) {
      // Click "boop": squash wider + shorter. Non-uniform, so the result is
      // scaled by a Lipschitz-safe factor below to keep the march stable.
      float bo = u_boop;
      p.x /= (1.0 + bo * 0.12);
      p.z /= (1.0 + bo * 0.12);
      p.y /= (1.0 - bo * 0.10);

      float body = sdRoundBox3(p, vec3(0.44, 0.35, 0.18), 0.13);

      vec3 e = p; e.x = abs(e.x) - 0.59;           // mirror ear pods
      float ears = sdRoundBox3(e, vec3(0.028, 0.12, 0.10), 0.035);

      float stalk = sdCapsule(p, vec3(0.0, 0.34, 0.0), vec3(0.0, 0.68, 0.0), 0.022);

      float shell = smin(body, ears, 0.045);
      shell = smin(shell, stalk, 0.03);

      float ball = length(p - vec3(0.0, 0.76, 0.0)) - 0.075;

      vec2 res = vec2(shell, 1.0);
      if (ball < res.x) res = vec2(ball, 2.0);
      res.x *= 0.85;
      return res;
    }

    vec3 calcNormal(vec3 p) {
      vec2 e = vec2(0.0015, 0.0);
      return normalize(vec3(
        map(p + e.xyy).x - map(p - e.xyy).x,
        map(p + e.yxy).x - map(p - e.yxy).x,
        map(p + e.yyx).x - map(p - e.yyx).x));
    }

    float calcAO(vec3 p, vec3 n) {
      float occ = 0.0, sca = 1.0;
      for (int i = 0; i < 5; i++) {
        float h = 0.012 + 0.10 * float(i) / 4.0;
        float d = map(p + n * h).x;
        occ += (h - d) * sca;
        sca *= 0.85;
      }
      return clamp(1.0 - 1.4 * occ, 0.0, 1.0);
    }

    void main() {
      vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
      float t = u_time;

      // --- Head orientation: a genuine 3D rotation toward the cursor --------
      float yaw   = u_look.x * YAW_AMT;
      float pitch = -u_look.y * PITCH_AMT;
      mat3 Rinv = rotX(-pitch) * rotY(-yaw);   // world -> local (object) space

      // Idle bob translates the whole robot in view space.
      float bob = u_motion * sin(t * 1.6) * 0.02 * u_bob;
      vec3 center = vec3(0.0, CENTER_Y + bob, 0.0);

      // --- Camera ray (perspective) -----------------------------------------
      vec3 ro = vec3(0.0, 0.0, CAM_Z);
      vec3 rd = normalize(vec3(uv.x, uv.y, -FOCAL));

      // Transform the ray into the robot's local space so primitives stay at
      // the origin and normals come out in local space (cheap, no transpose).
      vec3 roL = Rinv * (ro - center);
      vec3 rdL = Rinv * rd;

      // --- Raymarch with cone-footprint silhouette anti-aliasing -------------
      // March from just in front of the robot to just behind it (relative to
      // the camera distance) so the near/far bounds track CAM_Z.
      float tt = CAM_Z - 1.1;
      float tMax = CAM_Z + 1.1;
      float hit = 0.0;
      float edge = 1.0;     // smallest distance/footprint ratio seen (for AA)
      float tClose = tt;
      for (int i = 0; i < 96; i++) {
        vec3 pos = roL + rdL * tt;
        float d = map(pos).x;
        float foot = tt * (1.3 / u_resolution.y) / FOCAL;
        float ratio = d / foot;
        if (ratio < edge) { edge = ratio; tClose = tt; }
        if (d < 0.0004) { hit = 1.0; break; }
        tt += d;
        if (tt > tMax) break;
      }
      float cov = hit > 0.5 ? 1.0 : (1.0 - clamp(edge, 0.0, 1.0));
      float ts  = hit > 0.5 ? tt : tClose;
      vec3 lp   = roL + rdL * ts;        // local hit point (shading + decals)
      float matId = map(lp).y;

      // --- Lighting (key + fill, fresnel, iridescence, moving specular) ------
      vec3 N = calcNormal(lp);
      vec3 V = -rdL;
      float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);

      vec3 keyL  = Rinv * normalize(vec3(-0.45, 0.65, 0.55));  // light fixed in view
      vec3 fillL = Rinv * normalize(vec3( 0.50, 0.10, 0.40));

      float diff = clamp(dot(N, keyL), 0.0, 1.0);
      float fill = clamp(dot(N, fillL), 0.0, 1.0);
      float ao   = calcAO(lp, N);
      vec3  Hh   = normalize(keyL + V);
      float spec = pow(clamp(dot(N, Hh), 0.0, 1.0), 48.0);

      float pulseSpeed = (u_pulse < 0.01) ? 1.8 : u_pulse;
      float pulse = 0.5 + 0.5 * sin(t * pulseSpeed);

      // Shell material — dark blue body, spectral iridescent rim.
      float vshade = smoothstep(-0.5, 0.5, lp.y);
      vec3 baseBody = mix(vec3(0.05, 0.06, 0.12), vec3(0.17, 0.20, 0.31), vshade);
      vec3 amb = mix(vec3(0.03, 0.04, 0.08), vec3(0.10, 0.12, 0.18), N.y * 0.5 + 0.5);
      vec3 irid = spectral(fres * 0.8 + t * (0.05 + u_hover * 0.1)) * fres;

      vec3 col = baseBody * 0.45 + amb;
      col += baseBody * diff * 0.95;
      col += baseBody * fill * 0.25;
      col *= ao;
      col += irid * (0.45 + u_hover * 0.4);
      col += fres * fres * vec3(0.7, 0.8, 1.0) * 0.30;
      col += vec3(1.0, 1.0, 1.05) * spec * 0.85;                 // glossy glint
      col += u_antenna * fres * (0.04 + 0.06 * pulse);
      col = mix(col, vec3(0.85, 0.06, 0.06) * (0.5 + fres * 1.4), u_error * 0.5);

      // Antenna ball: emissive, pulsing accent.
      if (matId > 1.5) {
        float bdiff = clamp(dot(N, keyL), 0.0, 1.0);
        float ballLum = dot(u_antenna, vec3(0.299, 0.587, 0.114));
        vec3 ballTint = mix(u_antenna, vec3(ballLum), 0.3);
        col  = ballTint * (0.7 + 0.5 * pulse) + ballTint * bdiff * 0.4;
        col += vec3(1.0) * spec * 0.6;
        col += fres * vec3(1.0) * 0.4;
      }

      // --- Face decals: eyes + tool-call binary, printed on the front face ---
      // Only on the shell's forward-facing surface (local +z, near the front).
      float frontZ = smoothstep(0.12, 0.24, lp.z);
      float frontN = smoothstep(0.15, 0.55, N.z);
      float facing = frontZ * frontN * step(matId, 1.5);

      vec2 faceUv = lp.xy - u_look * 0.02;        // eyes drift toward the look

      // Hover perks the eyes up, but grow them OUTWARD so the gap between the
      // two eyes stays constant (the wide tool-call eyes must not merge).
      vec2 eBase = u_eye_size * EYE_K;
      vec2 eSize = eBase * (1.0 + u_hover * 0.2);
      float spread = 0.205 + max(eSize.x - eBase.x, 0.0);

      vec2 eyePos = faceUv;
      eyePos.x = abs(eyePos.x) - spread;           // mirror, spread
      eyePos.y -= 0.015;                           // sit slightly high
      vec2 nEye = eyePos;
      nEye.y += u_eye_curve * (nEye.x * nEye.x) * 2.5;

      float blinkT = mod(t, 4.0);
      float blink = (u_motion > 0.5 && u_error < 0.5 && (blinkT < 0.12 || (blinkT > 2.3 && blinkT < 2.42))) ? 1.0 : 0.0;

      float hEye = max(mix(eSize.y, 0.003, blink), 0.0018);
      float eyeSDF = sdRoundBox2(nEye, vec2(max(eSize.x, 0.0018), hEye), min(eSize.x, hEye) * 0.9);

      if (u_error > 0.01) {
        float xSDF = min(
          sdSegment(eyePos, vec2(-0.045, 0.045), vec2(0.045, -0.045)),
          sdSegment(eyePos, vec2(-0.045, -0.045), vec2(0.045, 0.045))
        ) - 0.012;
        eyeSDF = mix(eyeSDF, xSDF, smoothstep(0.1, 0.9, u_error));
      }

      float eyeOn = step(0.01, u_eye_bright);
      float aaF = 0.0045;
      float eyeMask = smoothstep(aaF, -aaF, eyeSDF) * eyeOn * facing;
      vec3 eyeCol = mix(vec3(2.4, 2.7, 2.9), vec3(3.0, 0.25, 0.25), u_error)
                  * u_eye_bright * (1.0 + u_hover * 0.25);
      col = mix(col, eyeCol, eyeMask);
      col += eyeCol * smoothstep(0.03, 0.0, eyeSDF) * 0.03 * eyeOn * facing;

      if (u_tool > 0.01) {
        vec2 fuv = faceUv * 7.0;
        fuv.y += t * (0.8 + hash(floor(fuv.x)) * 1.5);
        float bit = getBinaryBit(fract(fuv), floor(fuv.x) + floor(fuv.y) * 10.0);
        col += u_antenna * bit * 0.5 * u_tool * facing;
      }

      // --- Composite the robot as premultiplied colour ----------------------
      vec3 outRgb = col * cov;
      float outA = cov;

      // --- Status accessories: screen-space HUD above / beside the head ------
      float aa = 1.5 / u_resolution.y;
      float sway = u_motion * sin(t * 1.3) * 0.01;
      vec2 sp = uv;

      float accSDF = 1e9;
      float wifiRing = 0.0, wifiFill = 0.0;

      // WiFi (connecting): a dot + two arcs; hollow outlines fill one bar at a time.
      if (u_wifi > 0.01) {
        vec2 wp = sp - vec2(0.0, 0.34);
        float rr = length(wp);
        float clip = 0.006 - wp.y;
        float lineW = 0.0055;
        float b0 = rr - 0.018;
        float b1 = max(abs(rr - 0.052) - 0.015, clip);
        float b2 = max(abs(rr - 0.090) - 0.015, clip);
        float ph = mod(t * 1.4, 3.6);
        float f0 = smoothstep(-0.16, 0.16, ph - 0.0);
        float f1 = smoothstep(-0.16, 0.16, ph - 1.0);
        float f2 = smoothstep(-0.16, 0.16, ph - 2.0);
        float r0 = smoothstep(aa, -aa, abs(b0) - lineW);
        float r1 = smoothstep(aa, -aa, abs(b1) - lineW);
        float r2 = smoothstep(aa, -aa, abs(b2) - lineW);
        wifiRing = max(r0, max(r1, r2)) * u_wifi;
        float i0 = smoothstep(aa, -aa, b0) * f0;
        float i1 = smoothstep(aa, -aa, b1) * f1;
        float i2 = smoothstep(aa, -aa, b2) * f2;
        wifiFill = max(i0, max(i1, i2)) * u_wifi;
      }

      // Question mark (awaiting): hook + stem floating above the antenna.
      if (u_qm > 0.01) {
        vec2 qp = (sp - vec2(sway, 0.40)) / mix(0.65, 1.0, u_qm);
        vec2 hp = qp - vec2(0.0, 0.014);
        float hook = abs(length(hp) - 0.042) - 0.016;
        if (hp.x < 0.0 && hp.y < 0.0) hook += 0.5;
        float stem = sdSegment(qp, vec2(0.0, -0.030), vec2(0.0, -0.056)) - 0.015;
        float qm = min(hook, stem) + (1.0 - u_qm) * 0.4;
        accSDF = min(accSDF, qm);
      }

      // Wave bars (listening): equaliser just outside the right ear.
      if (u_wave > 0.01) {
        vec2 base = vec2(0.32, -0.07);
        for (int i = 0; i < 4; i++) {
          float fi = float(i);
          float bx = base.x + fi * 0.038;
          float hh = (0.022 + 0.050 * (0.5 + 0.5 * sin(t * 8.0 - fi * 1.2))) * u_wave;
          float bar = sdRoundBox2(sp - vec2(bx, base.y), vec2(0.011, hh), 0.010);
          accSDF = min(accSDF, bar);
        }
      }

      // Sleep Zs (sleeping): a drifting, fading cluster rising across the head.
      if (u_zzz > 0.01) {
        for (int i = 0; i < 4; i++) {
          float fi = float(i);
          float life = fract(t * 0.18 + fi * 0.25);
          vec2 zc = vec2(-0.05 + life * 0.16, -0.06 + life * 0.40);
          float sz = 0.034 * (0.7 + life * 0.7);
          float fade = smoothstep(0.0, 0.12, life) * smoothstep(1.0, 0.8, life);
          vec2 zp = sp - zc;
          float zt = sdSegment(zp, vec2(-sz, sz), vec2(sz, sz)) - 0.009;
          float zd = sdSegment(zp, vec2(sz, sz), vec2(-sz, -sz)) - 0.009;
          float zb = sdSegment(zp, vec2(-sz, -sz), vec2(sz, -sz)) - 0.009;
          float z = min(min(zt, zd), zb) + (1.0 - u_zzz) * 0.4 + (1.0 - fade) * 0.6;
          accSDF = min(accSDF, z);
        }
      }

      float accCov = smoothstep(aa, -aa, accSDF);
      float accLum = dot(u_antenna, vec3(0.299, 0.587, 0.114));
      vec3 accTint = mix(u_antenna, vec3(accLum), 0.6);
      vec3 accCol = accTint * 0.7 + vec3(0.45);

      // wifi: dim hollow rings, then a brighter fill climbing the bars
      vec3 wifiCol = mix(u_antenna, vec3(accLum), 0.6) * 0.75 + vec3(0.34);
      float ringA = wifiRing * 0.7;
      outRgb = outRgb * (1.0 - ringA) + wifiCol * 0.45 * ringA;
      outA   = max(outA, ringA);
      float fillA = wifiFill * 0.85;
      outRgb = outRgb * (1.0 - fillA) + wifiCol * fillA;
      outA   = max(outA, fillA);

      outRgb = outRgb * (1.0 - accCov) + accCol * accCov;
      outA   = outA   * (1.0 - accCov) + accCov;

      gl_FragColor = vec4(clamp(outRgb, 0.0, 1.9), clamp(outA, 0.0, 1.0));
    }
  `;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn("[robot] shader error:", gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function init() {
    const canvas = document.getElementById("robot-canvas");
    if (!canvas || canvas.dataset.robotInit === "1") return;
    canvas.dataset.robotInit = "1";

    const gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
    });
    if (!gl) { canvas.parentElement && canvas.parentElement.classList.add("robot-unsupported"); return; }

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("[robot] link error:", gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const U = {
      resolution: gl.getUniformLocation(prog, "u_resolution"),
      time: gl.getUniformLocation(prog, "u_time"),
      look: gl.getUniformLocation(prog, "u_look"),
      hover: gl.getUniformLocation(prog, "u_hover"),
      boop: gl.getUniformLocation(prog, "u_boop"),
      motion: gl.getUniformLocation(prog, "u_motion"),
      antenna: gl.getUniformLocation(prog, "u_antenna"),
      eyeSize: gl.getUniformLocation(prog, "u_eye_size"),
      eyeCurve: gl.getUniformLocation(prog, "u_eye_curve"),
      eyeBright: gl.getUniformLocation(prog, "u_eye_bright"),
      pulse: gl.getUniformLocation(prog, "u_pulse"),
      bob: gl.getUniformLocation(prog, "u_bob"),
      error: gl.getUniformLocation(prog, "u_error"),
      wifi: gl.getUniformLocation(prog, "u_wifi"),
      qm: gl.getUniformLocation(prog, "u_qm"),
      wave: gl.getUniformLocation(prog, "u_wave"),
      zzz: gl.getUniformLocation(prog, "u_zzz"),
      tool: gl.getUniformLocation(prog, "u_tool"),
    };

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // State tables ported from BASE_STATES (eye sizes scaled by the 0.70
    // model->canvas factor). Click cycles through them; values are lerped.
    const K = 0.70;
    const eye = (x, y) => [x * K, y * K];
    const STATES = [
      { name: "idle",        eye: eye(0.035, 0.035), curve: 1.5,  bright: 1.0, antenna: [0.3, 0.5, 0.8],  pulse: 0.0,  bob: 1.0, look: null,        error: 0, wifi: 0, qm: 0, wave: 0, zzz: 0, tool: 0 },
      { name: "listening",   eye: eye(0.045, 0.045), curve: 2.5,  bright: 1.0, antenna: [0.0, 1.0, 0.6],  pulse: 5.0,  bob: 1.0, look: null,        error: 0, wifi: 0, qm: 0, wave: 1, zzz: 0, tool: 0 },
      { name: "tool call",   eye: eye(0.12, 0.008),  curve: 0.0,  bright: 1.0, antenna: [0.0, 0.8, 1.0],  pulse: 20.0, bob: 1.0, look: [0.0, 0.0],  error: 0, wifi: 0, qm: 0, wave: 0, zzz: 0, tool: 1 },
      { name: "awaiting",    eye: eye(0.045, 0.025), curve: -3.0, bright: 1.0, antenna: [1.0, 0.7, 0.1],  pulse: 3.0,  bob: 1.0, look: [0.3, -0.2], error: 0, wifi: 0, qm: 1, wave: 0, zzz: 0, tool: 0 },
      { name: "connecting",  eye: eye(0.035, 0.002), curve: -1.5, bright: 0.6, antenna: [0.0, 1.0, 0.8],  pulse: 12.0, bob: 0.5, look: [0.0, 0.0],  error: 0, wifi: 1, qm: 0, wave: 0, zzz: 0, tool: 0 },
      { name: "sleeping",    eye: eye(0.035, 0.002), curve: -1.5, bright: 0.4, antenna: [0.1, 0.2, 0.6],  pulse: 1.5,  bob: 0.3, look: [0.0, 0.3],  error: 0, wifi: 0, qm: 0, wave: 0, zzz: 1, tool: 0 },
      { name: "ignoring",    eye: eye(0.03, 0.012),  curve: -1.5, bright: 1.0, antenna: [0.8, 0.1, 0.1],  pulse: 0.0,  bob: 1.0, look: null,        error: 0, wifi: 0, qm: 0, wave: 0, zzz: 0, tool: 0, avoid: true },
    ];

    let startIdx = 0;
    const dsName = canvas.getAttribute("data-state");
    if (dsName) {
      const i = STATES.findIndex((s) => s.name === dsName);
      if (i >= 0) startIdx = i;
    }
    const init0 = STATES[startIdx];
    const state = {
      idx: startIdx,
      look: { x: 0, y: 0 },
      lookTarget: { x: 0, y: 0 },   // cursor-driven look
      hover: 0,
      hoverTarget: 0,
      boop: 0,
      antenna: init0.antenna.slice(),
      eyeSize: { x: init0.eye[0], y: init0.eye[1] },
      eyeCurve: init0.curve,
      eyeBright: init0.bright,
      pulse: init0.pulse,
      bob: init0.bob,
      error: init0.error,
      wifi: init0.wifi,
      qm: init0.qm,
      wave: init0.wave,
      zzz: init0.zzz,
      tool: init0.tool,
    };

    let dpr = 1;
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    // Look-at-cursor: aim eyes/head toward the pointer relative to the robot.
    window.addEventListener("pointermove", (e) => {
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const half = Math.max(window.innerWidth, window.innerHeight) * 0.45;
      state.lookTarget.x = Math.max(-1, Math.min(1, (e.clientX - cx) / half));
      state.lookTarget.y = Math.max(-1, Math.min(1, (cy - e.clientY) / half));
    }, { passive: true });

    canvas.addEventListener("pointerenter", () => { state.hoverTarget = 1; });
    canvas.addEventListener("pointerleave", () => { state.hoverTarget = 0; });
    canvas.addEventListener("pointerdown", () => {
      state.boop = 1;
      state.idx = (state.idx + 1) % STATES.length;     // cycle to next state
    });
    canvas.style.cursor = "pointer";

    // Pause rendering when the robot isn't on screen.
    let visible = true;
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((entries) => {
        visible = entries[0].isIntersecting && entries[0].intersectionRatio > 0;
      }, { threshold: 0 }).observe(canvas);
    }

    window.addEventListener("resize", resize);
    resize();

    const start = performance.now();
    function frame(now) {
      requestAnimationFrame(frame);
      const shown = visible && canvas.offsetParent !== null;
      if (!shown) return;

      resize();
      const t = (now - start) / 1000;

      // Lerp toward the active state (mirrors lerpShaderValues in the source).
      const tgt = STATES[state.idx];
      const s = 0.10;
      state.eyeSize.x = lerp(state.eyeSize.x, tgt.eye[0], s);
      state.eyeSize.y = lerp(state.eyeSize.y, tgt.eye[1], s);
      state.eyeCurve = lerp(state.eyeCurve, tgt.curve, s);
      state.eyeBright = lerp(state.eyeBright, tgt.bright, s);
      state.pulse = lerp(state.pulse, tgt.pulse, s);
      state.bob = lerp(state.bob, tgt.bob, s);
      state.error = lerp(state.error, tgt.error, s);
      state.wifi = lerp(state.wifi, tgt.wifi, s);
      state.qm = lerp(state.qm, tgt.qm, s);
      state.wave = lerp(state.wave, tgt.wave, s);
      state.zzz = lerp(state.zzz, tgt.zzz, s);
      state.tool = lerp(state.tool, tgt.tool, s);
      state.antenna[0] = lerp(state.antenna[0], tgt.antenna[0], s);
      state.antenna[1] = lerp(state.antenna[1], tgt.antenna[1], s);
      state.antenna[2] = lerp(state.antenna[2], tgt.antenna[2], s);

      // Look: the "ignoring" state averts its gaze (aims opposite the cursor);
      // otherwise follow the cursor on hover, or honour a fixed state override.
      let lx, ly;
      if (tgt.avoid) {
        lx = Math.max(-1, Math.min(1, -state.lookTarget.x * 1.4));
        ly = Math.max(-1, Math.min(1, -state.lookTarget.y * 1.4));
      } else if (state.hoverTarget) {
        lx = state.lookTarget.x;
        ly = state.lookTarget.y;
      } else {
        lx = tgt.look ? tgt.look[0] : state.lookTarget.x;
        ly = tgt.look ? tgt.look[1] : state.lookTarget.y;
      }
      state.look.x = lerp(state.look.x, lx, 0.08);
      state.look.y = lerp(state.look.y, ly, 0.08);
      state.hover = lerp(state.hover, state.hoverTarget, 0.12);
      state.boop = lerp(state.boop, 0, 0.10);

      gl.useProgram(prog);
      gl.uniform2f(U.resolution, canvas.width, canvas.height);
      gl.uniform1f(U.time, reduceMotion ? 0.0 : t);
      gl.uniform2f(U.look, state.look.x, state.look.y);
      gl.uniform1f(U.hover, state.hover);
      gl.uniform1f(U.boop, state.boop);
      gl.uniform1f(U.motion, reduceMotion ? 0.0 : 1.0);
      gl.uniform3f(U.antenna, state.antenna[0], state.antenna[1], state.antenna[2]);
      gl.uniform2f(U.eyeSize, state.eyeSize.x, state.eyeSize.y);
      gl.uniform1f(U.eyeCurve, state.eyeCurve);
      gl.uniform1f(U.eyeBright, state.eyeBright);
      gl.uniform1f(U.pulse, state.pulse);
      gl.uniform1f(U.bob, state.bob);
      gl.uniform1f(U.error, state.error);
      gl.uniform1f(U.wifi, state.wifi);
      gl.uniform1f(U.qm, state.qm);
      gl.uniform1f(U.wave, state.wave);
      gl.uniform1f(U.zzz, state.zzz);
      gl.uniform1f(U.tool, state.tool);

      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    requestAnimationFrame(frame);
  }

  window.initRobot = init;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
