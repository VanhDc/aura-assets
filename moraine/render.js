/* ═══════════ MORAINE · the renderer ═══════════
   Kestrel's vertex-pulling WebGPU renderer, grown for a scene graph. What changed and why:

   · Every GLB becomes ONE set of storage buffers (positions, normals+tangents, uv+ids, joints+
     weights, morph deltas, indices) plus a per-part table and a matrix buffer that holds every
     node's world matrix and every skin's joint palette. A vertex carries its PART index in POS.w
     and looks up the rest. That is what lets 500 chain links, stones and cells be separate nodes
     without 500 draw calls or 500 pipelines · the file's node count stops being a cost.
   · One pipeline set per MATERIAL, not per part. Parts sharing a material are contiguous in the
     merged index buffer, so a material is one draw with a first-vertex offset. Blender writes
     one primitive per material, so a bike is a dozen draws.
   · The vertex path: morph deltas (weights per part) → optional VAT delta (before the node
     rotation, as the CONTRACT says) → skin palette OR node world matrix. The skinned mesh's own
     node transform is ignored, as the glTF spec says: the joints carry it.
   · Materials are the full glTF PBR set: baseColor (sRGB), metallicRoughness, normal (the file's
     TANGENT, or a screen-space cotangent frame without it), occlusion, emissive,
     KHR_texture_transform, KHR_materials_clearcoat as a second glossy lobe over the smooth
     geometric normal, per-material wrap modes and 16× anisotropy, mip chains generated at load.
   · Light is a small procedural STUDIO (a paper-warm dome, a large key softbox, a cool fill, a
     sand bounce) prefiltered once into an equirect roughness mip chain plus an irradiance map,
     read with a split-sum approximation · that is what makes anodised aluminium read as metal
     and paint as paint. The sun (shadow-mapped) and the file's spots sit on top. The studio's
     key panel follows the sun's azimuth so highlight and shadow agree.
   · The scene pass writes TWO targets: colour with linear depth in alpha, and the shaded normal.
     The post pass uses both for a normal-oriented screen-space occlusion (no self-occlusion on
     a curved tube, real contact where a spoke meets the hub), an analytic ground shadow from the
     sun map, a soft CONTACT shadow under whatever touches the ground, ACES tone mapping.
   · alphaMode BLEND parts (and KHR_materials_transmission glass) are drawn after the opaque pass
     into a SEPARATE premultiplied target, sorted back to front, and composited in the post pass.
   · Camera from the file: a glTF camera node's world matrix is the view, its yfov the projection,
     plus Kestrel's NDC lens shift for the copy column and a critically damped spring so chapters
     glide. Lights from the file: a directional `Sun` (casts the shadow map), a spot `Headlight`,
     an optional spot `Studio`, all with live intensity from the pointer channels. The sun writes
     `--sun` on <html> so the page ground can follow it. */

/* a real ES module · build.sh keeps _engine.js and _render.js as modules behind an import map */
import { parseGLB, M4, quatAxis, clampf } from 'moraine/engine';

const TG = 'https://esm.sh/typegpu@0.12.0';
const SHADOW_RES = 2048;
/* the studio · equirect, 8 roughness levels (512 → 4 px wide), plus a 64×32 irradiance map */
const ENV_W = 512, ENV_H = 256, ENV_MIPS = 8, IRR_W = 64, IRR_H = 32;

/* ── camera maths · column-major, WebGPU clip z in [0,1] ── */
function projection(yfov, aspect, near, far, fx=0, fy=0){
  const t=1/Math.tan(yfov/2);
  const A=far/(near-far), B=far*near/(near-far);
  /* column 2, rows 0/1 are a lens shift · +fx slides the SUBJECT right in NDC at any distance,
     which is how a chapter hands its copy a clean column without touching the framing */
  return [t/aspect,0,0,0, 0,t,0,0, -fx,-fy,A,-1, 0,0,B,0];
}
/* view from a camera WORLD matrix · glTF cameras look down local -Z with +Y up */
function viewFromWorld(W){ return M4.invert(W); }
function worldFromPosQuat(p,q){ return M4.fromTRS(p,q,[1,1,1]); }
function quatFromMat(W){
  /* normalise the columns first · a camera parented under a scaled empty is still a camera */
  const c=[[W[0],W[1],W[2]],[W[4],W[5],W[6]],[W[8],W[9],W[10]]].map(v=>{const l=Math.hypot(...v)||1;return v.map(x=>x/l);});
  const m00=c[0][0],m01=c[1][0],m02=c[2][0], m10=c[0][1],m11=c[1][1],m12=c[2][1], m20=c[0][2],m21=c[1][2],m22=c[2][2];
  const tr=m00+m11+m22; let q;
  if (tr>0){ const s=Math.sqrt(tr+1)*2; q=[(m21-m12)/s,(m02-m20)/s,(m10-m01)/s,0.25*s]; }
  else if (m00>m11 && m00>m22){ const s=Math.sqrt(1+m00-m11-m22)*2; q=[0.25*s,(m01+m10)/s,(m02+m20)/s,(m21-m12)/s]; }
  else if (m11>m22){ const s=Math.sqrt(1+m11-m00-m22)*2; q=[(m01+m10)/s,0.25*s,(m12+m21)/s,(m02-m20)/s]; }
  else { const s=Math.sqrt(1+m22-m00-m11)*2; q=[(m02+m20)/s,(m12+m21)/s,0.25*s,(m10-m01)/s]; }
  return q;
}
/* ortho light matrix for the sun · the frustum keeps its shape as the lamp moves so one depth
   bias stays valid for every chapter */
function lightMatrix(dir, centre, half, depth){
  /* the light camera stands on the SUN side and looks along the light's travel direction, so
     depth grows away from the sun and the map's `less` test keeps the surface nearest the sun.
     (Negating `dir` here put the camera on the far side looking back: the map then held the
     FARTHEST surface and every lit face of the bike compared as shadowed.) */
  const f=[dir[0],dir[1],dir[2]]; const fl=Math.hypot(...f)||1; f[0]/=fl; f[1]/=fl; f[2]/=fl;
  const Lp=[centre[0]-f[0]*depth*0.5, centre[1]-f[1]*depth*0.5, centre[2]-f[2]*depth*0.5];
  let up=[0,1,0]; if (Math.abs(f[1])>0.985) up=[0,0,1];
  const s=[f[1]*up[2]-f[2]*up[1], f[2]*up[0]-f[0]*up[2], f[0]*up[1]-f[1]*up[0]];
  const sl=Math.hypot(...s)||1; s[0]/=sl; s[1]/=sl; s[2]/=sl;
  const u=[s[1]*f[2]-s[2]*f[1], s[2]*f[0]-s[0]*f[2], s[0]*f[1]-s[1]*f[0]];
  const Vm=[s[0],u[0],-f[0],0, s[1],u[1],-f[1],0, s[2],u[2],-f[2],0,
           -(s[0]*Lp[0]+s[1]*Lp[1]+s[2]*Lp[2]), -(u[0]*Lp[0]+u[1]*Lp[1]+u[2]*Lp[2]), (f[0]*Lp[0]+f[1]*Lp[1]+f[2]*Lp[2]), 1];
  const n=1, fr=depth;
  const O=[1/half,0,0,0, 0,1/half,0,0, 0,0,-1/(fr-n),0, 0,0,-n/(fr-n),1];
  return M4.mul(O, Vm);
}
const v4 = (d,m,i) => d.vec4f(m[i],m[i+1],m[i+2],m[i+3]);
/* the studio's key softbox sits here in the env map · the lookup is yawed so it follows the sun */
const KEY_DIR = [-0.35, 0.85, 0.35];

export async function createRenderer(canvas, opts={}){
  if (!navigator.gpu) throw new Error('no WebGPU');
  const tgpu=(await import(TG)).default;
  const d=await import(TG+'/data');
  const root=await tgpu.init();
  const device=root.device;
  const FORMAT=navigator.gpu.getPreferredCanvasFormat();
  /* without this a WGSL compile error is a black canvas and nothing else */
  const errors=[];
  device.onuncapturederror = e => { errors.push(e.error.message); console.error('WEBGPU', e.error.message); };
  const ctx=canvas.getContext('webgpu');
  ctx.configure({device, format:FORMAT, alphaMode:'premultiplied'});
  const limits=device.limits;

  /* material samplers · trilinear + 16× anisotropy, wrap modes from the file's sampler; one per
     wrap combination, shared by every material that asks for it */
  const samplerCache=new Map();
  function materialSampler(wrapU='repeat', wrapT='repeat'){
    const k=wrapU+'|'+wrapT;
    if (!samplerCache.has(k)) samplerCache.set(k, root.createSampler({magFilter:'linear',minFilter:'linear',mipmapFilter:'linear',
      addressModeU:wrapU, addressModeV:wrapT, maxAnisotropy:16}));
    return samplerCache.get(k);
  }
  const clampSampler=root.createSampler({magFilter:'linear',minFilter:'linear',
    addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'});
  const shadowSampler=root.createSampler({magFilter:'nearest',minFilter:'nearest',
    addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'});
  /* the env map wraps in longitude and clamps at the poles */
  const envSampler=root.createSampler({magFilter:'linear',minFilter:'linear',mipmapFilter:'linear',
    addressModeU:'repeat',addressModeV:'clamp-to-edge'});

  /* ── shadow map · rgba16float, not r32float (unfilterable, and the auto bind group asks for
     filterable). 2048² over a 1.6 m frame is ~0.8 mm per texel, which resolves a spoke. ── */
  const shadowTex=root.createTexture({size:[SHADOW_RES,SHADOW_RES],format:'rgba16float'}).$usage('sampled','render');
  const shadowView=shadowTex.createView();
  const shadowTarget=root.unwrap(shadowTex).createView();
  const shadowDepth=device.createTexture({size:[SHADOW_RES,SHADOW_RES],format:'depth24plus',
    usage:GPUTextureUsage.RENDER_ATTACHMENT}).createView();

  /* ── a raw GPUBuffer wrapped for TypeGPU · the TypeGPU init path serialises JS arrays element
     by element, which is fine for 64 keys and not for 120k vertices. mappedAtCreation is one memcpy. ── */
  function storageBuf(schema, f32, dynamic=false){
    const bytes=Math.max(16, Math.ceil(f32.byteLength/16)*16);
    const gb=device.createBuffer({size:bytes, usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST, mappedAtCreation:true});
    new Uint8Array(gb.getMappedRange()).set(new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength));
    gb.unmap();
    const tb=root.createBuffer(schema, gb).$usage('storage');
    return { gb, ro: tb.as('readonly'), tb };
  }
  /* a material texture with a full mip chain · a 2048² tread map sampled at level 0 from three
     metres away is sparkle, sampled through its mips it is rubber. PNG and webp both decode here. */
  const texCache=new Map();
  async function loadTex(blob, fmt, fallback){
    const key = blob ? blob : (fmt+fallback.join(','));
    if (texCache.has(key)) return texCache.get(key);
    let bmp=null;
    try { bmp = blob ? await createImageBitmap(blob,{colorSpaceConversion:'none'}) : null; } catch(e){ console.warn('texture decode', e); }
    if (!bmp) bmp = await createImageBitmap(new ImageData(new Uint8ClampedArray(fallback),1,1));
    const mips = 1 + Math.floor(Math.log2(Math.max(bmp.width, bmp.height)));
    const tex=root.createTexture({size:[bmp.width,bmp.height],format:fmt, mipLevelCount:mips}).$usage('sampled','render');
    tex.write(bmp,{fit:'stretch'});
    if (mips>1) tex.generateMipmaps();
    const view=tex.createView();
    texCache.set(key, view);
    return view;
  }

  /* ── uniforms ── */
  const Frame=d.struct({
    m0:d.vec4f,m1:d.vec4f,m2:d.vec4f,m3:d.vec4f,          /* view-projection */
    s0:d.vec4f,s1:d.vec4f,s2:d.vec4f,s3:d.vec4f,          /* sun view-projection (shadow) */
    eye:d.vec3f, near:d.f32,
    camRight:d.vec3f, far:d.f32,
    camUp:d.vec3f, tanH:d.f32,
    camFwd:d.vec3f, aspect:d.f32,
    sunDir:d.vec3f, sunI:d.f32,
    sunCol:d.vec3f, shadowOn:d.f32,
    headPos:d.vec3f, headI:d.f32,
    headDir:d.vec3f, headCos:d.f32,
    headCol:d.vec3f, headCosIn:d.f32,
    studioPos:d.vec3f, studioI:d.f32,
    studioDir:d.vec3f, studioCos:d.f32,
    studioCol:d.vec3f, studioCosIn:d.f32,
    clip:d.vec4f,                                         /* world plane n·p + d ≥ 0 keeps */
    clipOn:d.f32, dissolve:d.f32, sweep:d.f32, wire:d.f32,
    mode:d.f32, theme:d.f32, ambient:d.f32, viewW:d.f32,
    vat:d.vec4f,                                          /* W, rows, frame0, frame1 */
    vatMin:d.vec3f, vatMix:d.f32,
    vatMax:d.vec3f, vatOn:d.f32,
    time:d.f32, groundY:d.f32, dissolveCell:d.f32, spotScale:d.f32,
    dissolveX:d.vec2f, spotRange:d.f32, exposure:d.f32,
    envRot:d.f32, dust:d.f32, envStrength:d.f32, specStrength:d.f32,
    sunGain:d.f32, shadowBias:d.f32, inkMode:d.f32, grow:d.f32,   /* inkMode 1 = cyan wire on dark (v3 · the ink act) · grow: _GROW threshold, 2 = off */
    /* appended in whole 16-byte rows on PURPOSE · this struct is packed four floats to a row, and
       slipping a vec3f into the middle of it re-padded everything after and darkened the whole page */
    hazeCol:d.vec4f,
    hazeNear:d.f32, hazeFar:d.f32, hazeAmt:d.f32, _f4:d.f32,
  });
  const F={
    m0:d.vec4f(1,0,0,0),m1:d.vec4f(0,1,0,0),m2:d.vec4f(0,0,1,0),m3:d.vec4f(0,0,0,1),
    s0:d.vec4f(1,0,0,0),s1:d.vec4f(0,1,0,0),s2:d.vec4f(0,0,1,0),s3:d.vec4f(0,0,0,1),
    eye:d.vec3f(0,0,1000), near:10, camRight:d.vec3f(1,0,0), far:8000, camUp:d.vec3f(0,1,0), tanH:0.3,
    camFwd:d.vec3f(0,0,-1), aspect:1.6,
    sunDir:d.vec3f(-0.45,-0.75,-0.45), sunI:1, sunCol:d.vec3f(1,0.97,0.92), shadowOn:1,
    headPos:d.vec3f(0,0,0), headI:0, headDir:d.vec3f(0,0,-1), headCos:0.8, headCol:d.vec3f(1,1,1), headCosIn:0.9,
    studioPos:d.vec3f(0,0,0), studioI:0, studioDir:d.vec3f(0,0,-1), studioCos:0.8, studioCol:d.vec3f(1,1,1), studioCosIn:0.9,
    clip:d.vec4f(0,1,0,0), clipOn:0, dissolve:0, sweep:99999, wire:0,
    mode:0, theme:1, ambient:1, viewW:1000,
    vat:d.vec4f(1024,1,0,0), vatMin:d.vec3f(0,0,0), vatMix:0, vatMax:d.vec3f(0,0,0), vatOn:0,
    time:0, groundY:-280, dissolveCell:0.05, spotScale:0.0025,
    dissolveX:d.vec2f(-900,900), spotRange:600, exposure:0.15,
    envRot:0, dust:0.25, envStrength:1, specStrength:1,
    sunGain:3.5, shadowBias:0.0009, inkMode:0, grow:2,
    hazeCol:d.vec4f(0.82,0.79,0.74,0), hazeNear:400, hazeFar:1600, hazeAmt:0, _f4:0,
  };
  const frameUni=root.createUniform(Frame, F);

  const Mat=d.struct({
    base:d.vec4f,
    emissive:d.vec3f, metal:d.f32,
    rough:d.f32, hasTex:d.f32, alphaMode:d.f32, cutoff:d.f32,
    nrmScale:d.f32, occStrength:d.f32, hasNrm:d.f32, hasOrm:d.f32,
    uvScale:d.vec2f, uvOffset:d.vec2f,
    uvRot:d.f32, clearcoat:d.f32, coatRough:d.f32, hasOcc:d.f32,
    ormOcc:d.f32, hasEmis:d.f32, transmission:d.f32, isEnv:d.f32,   /* isEnv 1 = an environment material (env.glb): no clip/dissolve/wire/sweep/grow/ink-wire */
  });

  /* ── the studio · analytic radiance, evaluated only while prefiltering ──
     Y-up. A paper-warm dome over a sand bounce (theme 0, the page) or a blue-hour dome over a
     dark ground (theme 1, the harness and the hero's first seconds); a large key softbox high
     left-front, a cooler wider fill right-back, a thin rim strip behind. Values are radiance in
     the sun's units (a 3 W/m² sun is daylight on this page). */
  const envRadiance=tgpu.fn([d.vec3f,d.f32],d.vec3f)`(dir, theme){
    let y = dir.y;
    let skyL = mix(vec3f(0.56,0.52,0.46), vec3f(0.34,0.37,0.44), clamp(y,0.0,1.0));
    let gndL = mix(vec3f(0.40,0.36,0.30), vec3f(0.18,0.16,0.14), clamp(-y,0.0,1.0));
    var cL = mix(gndL, skyL, smoothstep(-0.10, 0.10, y));
    let skyD = mix(vec3f(0.16,0.12,0.14), vec3f(0.020,0.030,0.080), clamp(y,0.0,1.0));
    let gndD = mix(vec3f(0.045,0.042,0.045), vec3f(0.02,0.02,0.024), clamp(-y,0.0,1.0));
    var cD = mix(gndD, skyD, smoothstep(-0.10, 0.10, y));
    let glow = pow(max(dot(dir, normalize(vec3f(-0.55,0.06,-0.83))), 0.0), 10.0);
    cD = cD + vec3f(0.60,0.28,0.10)*glow*0.9;
    let key  = smoothstep(0.68, 0.90, dot(dir, normalize(vec3f(${KEY_DIR.join(',')}))));
    let fill = smoothstep(0.48, 0.84, dot(dir, normalize(vec3f(0.80,0.25,-0.50))));
    let rim  = smoothstep(0.90, 0.985, dot(dir, normalize(vec3f(0.20,0.30,-0.93))));
    cL = cL + vec3f(1.00,0.98,0.95)*key*4.5 + vec3f(0.86,0.91,1.00)*fill*0.9 + vec3f(1.0)*rim*1.4;
    cD = cD + vec3f(0.85,0.90,1.00)*key*1.9 + vec3f(0.60,0.72,1.00)*fill*0.6 + vec3f(1.0,0.85,0.7)*rim*1.2;
    return mix(cL, cD, theme);
  }`;
  const dirToUV=tgpu.fn([d.vec3f],d.vec2f)`(dir){
    let u = atan2(dir.x, -dir.z) * 0.15915494 + 0.5;
    let v = acos(clamp(dir.y, -1.0, 1.0)) * 0.31830989;
    return vec2f(u, v);
  }`;
  const uvToDir=tgpu.fn([d.vec2f],d.vec3f)`(uv){
    let phi = (uv.x - 0.5) * 6.2831853;
    let th = uv.y * 3.14159265;
    return vec3f(sin(th)*sin(phi), cos(th), -sin(th)*cos(phi));
  }`;
  const hammersley=tgpu.fn([d.u32,d.u32],d.vec2f)`(i, n){
    var b = i;
    b = (b << 16u) | (b >> 16u);
    b = ((b & 0x55555555u) << 1u) | ((b & 0xAAAAAAAAu) >> 1u);
    b = ((b & 0x33333333u) << 2u) | ((b & 0xCCCCCCCCu) >> 2u);
    b = ((b & 0x0F0F0F0Fu) << 4u) | ((b & 0xF0F0F0F0u) >> 4u);
    b = ((b & 0x00FF00FFu) << 8u) | ((b & 0xFF00FF00u) >> 8u);
    return vec2f(f32(i)/f32(n), f32(b) * 2.3283064365386963e-10);
  }`;
  const EnvU=d.struct({ rough:d.f32, theme:d.f32, samples:d.f32, irr:d.f32 });
  const fsVert=tgpu.vertexFn({in:{vi:d.builtin.vertexIndex}, out:{pos:d.builtin.position, uv:d.vec2f}})`{
    var q = array<vec2f,3>(vec2f(-1.0,-1.0), vec2f(3.0,-1.0), vec2f(-1.0,3.0));
    let xy = q[in.vi];
    return Out(vec4f(xy,0.0,1.0), vec2f((xy.x+1.0)*0.5, 1.0-(xy.y+1.0)*0.5));
  }`;
  /* GGX prefilter (N = V = R, Hammersley importance sampling) or a cosine-weighted irradiance
     convolution, straight off the analytic studio · no seams, no source texture */
  function buildPrefilter(uni){
    const frag=tgpu.fragmentFn({in:{uv:d.vec2f}, out:d.vec4f})`{
      let N = uvToDir(in.uv);
      var up = vec3f(0.0, 1.0, 0.0);
      if (abs(N.y) > 0.999) { up = vec3f(1.0, 0.0, 0.0); }
      let T = normalize(cross(up, N));
      let B = cross(N, T);
      let n = u32(E.samples);
      if (n < 2u) { return vec4f(envRadiance(N, E.theme), 1.0); }
      let a = max(E.rough*E.rough, 0.002);
      var sum = vec3f(0.0);
      var wsum = 0.0;
      for (var i = 0u; i < n; i = i + 1u) {
        let xi = hammersley(i, n);
        let phi = 6.2831853 * xi.x;
        if (E.irr > 0.5) {
          let r = sqrt(xi.y);
          let L = T*(r*cos(phi)) + B*(r*sin(phi)) + N*sqrt(max(1.0 - xi.y, 0.0));
          sum = sum + envRadiance(L, E.theme);
          wsum = wsum + 1.0;
        } else {
          let cosT = sqrt((1.0 - xi.y) / (1.0 + (a*a - 1.0)*xi.y));
          let sinT = sqrt(max(1.0 - cosT*cosT, 0.0));
          let H = T*(sinT*cos(phi)) + B*(sinT*sin(phi)) + N*cosT;
          let L = 2.0*dot(N, H)*H - N;
          let ndl = dot(N, L);
          if (ndl > 0.0) { sum = sum + envRadiance(L, E.theme)*ndl; wsum = wsum + ndl; }
        }
      }
      return vec4f(sum / max(wsum, 1e-4), 1.0);
    }`.$uses({E:uni, envRadiance, uvToDir, hammersley});
    return root.createRenderPipeline({vertex:fsVert, fragment:frag, targets:{format:'rgba16float'}});
  }
  function buildEnv(theme){
    const spec=root.createTexture({size:[ENV_W,ENV_H],format:'rgba16float',mipLevelCount:ENV_MIPS}).$usage('sampled','render');
    const irr=root.createTexture({size:[IRR_W,IRR_H],format:'rgba16float'}).$usage('sampled','render');
    const rawS=root.unwrap(spec), rawI=root.unwrap(irr);
    for (let l=0;l<ENV_MIPS;l++){
      const rough=l/(ENV_MIPS-1);
      /* one uniform per level · TypeGPU queues the draws, so a shared uniform rewritten between
         them would render every level with the last value */
      const u=root.createUniform(EnvU, {rough, theme, samples: l===0 ? 1 : (l<3 ? 384 : 256), irr:0});
      buildPrefilter(u).withColorAttachment({view: rawS.createView({baseMipLevel:l, mipLevelCount:1}), clearValue:[0,0,0,1], loadOp:'clear', storeOp:'store'}).draw(3);
    }
    const ui=root.createUniform(EnvU, {rough:1, theme, samples:512, irr:1});
    buildPrefilter(ui).withColorAttachment({view: rawI.createView(), clearValue:[0,0,0,1], loadOp:'clear', storeOp:'store'}).draw(3);
    return { spec: spec.createView(), irr: irr.createView() };
  }
  const envL=buildEnv(0), envD=buildEnv(1);
  root['~unstable']?.flush?.();

  /* ── shader pieces · Y-up world ── */
  /* the studio, read back · yawed by envRot so the key panel sits where the sun is */
  const envDir=tgpu.fn([d.vec3f],d.vec3f)`(v){
    let c = cos(F.envRot); let s = sin(F.envRot);
    return vec3f(c*v.x + s*v.z, v.y, -s*v.x + c*v.z);
  }`.$uses({F:frameUni});
  const envSpec=tgpu.fn([d.vec3f,d.f32],d.vec3f)`(dir, rough){
    let uv = dirToUV(envDir(dir));
    let lod = rough * ${ENV_MIPS-1}.0;
    return mix(textureSampleLevel(ENVL, ES, uv, lod).rgb, textureSampleLevel(ENVD, ES, uv, lod).rgb, F.theme);
  }`.$uses({F:frameUni, ENVL:envL.spec, ENVD:envD.spec, ES:envSampler, dirToUV, envDir});
  const envIrr=tgpu.fn([d.vec3f],d.vec3f)`(n){
    let uv = dirToUV(envDir(n));
    return mix(textureSampleLevel(IRRL, ES, uv, 0.0).rgb, textureSampleLevel(IRRD, ES, uv, 0.0).rgb, F.theme);
  }`.$uses({F:frameUni, IRRL:envL.irr, IRRD:envD.irr, ES:envSampler, dirToUV, envDir});
  /* the split-sum's second term · Karis' analytic fit of the BRDF LUT */
  const envBRDF=tgpu.fn([d.vec3f,d.f32,d.f32],d.vec3f)`(F0, rough, ndv){
    let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
    let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
    let r = rough*c0 + c1;
    let a004 = min(r.x*r.x, exp2(-9.28*ndv))*r.x + r.y;
    let ab = vec2f(-1.04, 1.04)*a004 + r.zw;
    return F0*ab.x + vec3f(ab.y);
  }`;
  /* Lagarde's specular occlusion · AO also dims the reflection, most on rough surfaces at grazing */
  const specOcc=tgpu.fn([d.f32,d.f32,d.f32],d.f32)`(ndv, ao, rough){
    return clamp(pow(ndv + ao, exp2(-16.0*rough - 1.0)) - 1.0 + ao, 0.0, 1.0);
  }`;
  const ggx=tgpu.fn([d.vec3f,d.vec3f,d.vec3f,d.f32],d.f32)`(N,V,L,rough){
    let a  = max(rough*rough, 0.0045);
    let a2 = a*a;
    let H = normalize(V+L);
    let ndh = max(dot(N,H), 0.0);
    let ndv = max(dot(N,V), 1e-4);
    let ndl = max(dot(N,L), 0.0);
    let d0 = ndh*ndh*(a2-1.0)+1.0;
    let D = a2/(3.14159265*d0*d0);
    let lv = ndl*sqrt(ndv*ndv*(1.0-a2)+a2);
    let ll = ndv*sqrt(ndl*ndl*(1.0-a2)+a2);
    return min(D*(0.5/max(lv+ll,1e-5)), 24.0);
  }`;
  const srgb=tgpu.fn([d.vec3f],d.vec3f)`(c){
    let lo=c*12.92;
    let hi=1.055*pow(max(c,vec3f(0.0)),vec3f(1.0/2.4))-0.055;
    return select(hi, lo, c<=vec3f(0.0031308));
  }`;
  /* ACES · Stephen Hill's fit, sRGB primaries in and out */
  const aces=tgpu.fn([d.vec3f],d.vec3f)`(c){
    let m1 = mat3x3f(vec3f(0.59719,0.07600,0.02840), vec3f(0.35458,0.90834,0.13383), vec3f(0.04823,0.01566,0.83777));
    let m2 = mat3x3f(vec3f(1.60475,-0.10208,-0.00327), vec3f(-0.53108,1.10813,-0.07276), vec3f(-0.07367,-0.00605,1.07602));
    let v = m1*c;
    let a = v*(v + vec3f(0.0245786)) - vec3f(0.000090537);
    let b = v*(0.983729*v + vec3f(0.4329510)) + vec3f(0.238081);
    return clamp(m2*(a/b), vec3f(0.0), vec3f(1.0));
  }`;
  /* AgX · Blender's default view transform (Wrensch's fit): a gentle toe that keeps black rubber
     readable and a long shoulder for the paint's highlight. Returns LINEAR display values. */
  const agx=tgpu.fn([d.vec3f],d.vec3f)`(c){
    let m = mat3x3f(vec3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051),
                    vec3f(0.0784335999999992, 0.878468636469772, 0.0784336),
                    vec3f(0.0792237451477643, 0.0791661274605434, 0.879142973793104));
    let inv = mat3x3f(vec3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438),
                      vec3f(-0.0980208811401368, 1.15190312990417, -0.0980434501171241),
                      vec3f(-0.0990297440797205, -0.0989611768448433, 1.15107367264116));
    var v = m * max(c, vec3f(1e-6));
    v = clamp(log2(v), vec3f(-12.47393), vec3f(4.026069));
    v = (v + vec3f(12.47393)) / 16.5;
    let x2 = v*v;
    let x4 = x2*x2;
    v = 15.5*x4*x2 - 40.14*x4*v + 31.96*x4 - 6.868*x2*v + 0.4298*x2 + 0.1191*v - vec3f(0.00232);
    v = inv * clamp(v, vec3f(0.0), vec3f(1.0));
    return pow(max(v, vec3f(0.0)), vec3f(2.2));
  }`;
  const matcap=tgpu.fn([d.vec3f,d.f32],d.vec3f)`(vn, theme){
    let key    = max(dot(vn, normalize(vec3f(-0.42, 0.62, 0.66))), 0.0);
    let bounce = max(dot(vn, normalize(vec3f( 0.15,-0.85, 0.50))), 0.0);
    let rim    = pow(1.0 - max(vn.z, 0.0), 2.6);
    let horizon = smoothstep(-0.05, 0.05, vn.y);
    var c = mix(vec3f(0.020,0.022,0.030), vec3f(0.62,0.64,0.70), pow(key, 1.35));
    c = mix(c*0.55, c*1.35 + vec3f(0.10,0.11,0.13), horizon);
    c = c + vec3f(0.85,0.42,0.16)*bounce*0.42;
    c = c + vec3f(1.0,0.98,0.94)*pow(key, 46.0)*2.40;
    c = c + vec3f(0.42,0.60,1.00)*rim*0.55;
    return c;
  }`;
  /* a spot's contribution · RAW watts from the file, an art-directed scale, a soft cone */
  const spot=tgpu.fn([d.vec3f,d.vec3f,d.vec3f,d.f32,d.f32,d.f32,d.f32,d.f32],d.vec4f)`(wp, pos, dir, I, cosOut, cosIn, scale, range){
    let dv = pos - wp;
    let dist = max(length(dv), 1e-3);
    let L = dv / dist;
    let cd = dot(-L, dir);
    let cone = smoothstep(cosOut, max(cosIn, cosOut + 1e-3), cd);
    let atten = 1.0 / (1.0 + (dist*dist)/(range*range));
    return vec4f(L, I*scale*atten*cone);
  }`;

  /* ── the vertex body · shared by the shadow and scene passes so the shadow deforms with the
     model (a shadow cast by the rest pose while a wheel turns is the classic bug) ── */
  const VERT_BODY = `
      let i = IDX[in.vi];
      let P4 = POS[i];
      let part = u32(P4.w + 0.5);
      let N4 = NRM[2u*i];
      let T4 = NRM[2u*i + 1u];       /* the file's TANGENT · w = handedness, 0 = none */
      let uva = UVA[i];
      let pb = part * 4u;
      let pa = PARTS[pb];          /* node, skinOffset(-1 = none), vertexBase, morphBase */
      let pc = PARTS[pb + 1u];     /* nTargets, vertexCount, hasVat, visible */
      let mw = PARTS[pb + 2u];     /* morph weights 0..3 */
      let tint = PARTS[pb + 3u];   /* per-part tint rgb + strength */
      var p = P4.xyz;
      var n = N4.xyz;
      /* morph targets · deltas live in one buffer, target t of part at morphBase + t*vcount */
      let nt = u32(pc.x);
      let vc = u32(pc.y);
      let local = i - u32(pa.z);
      let mb = u32(pa.w);
      if (nt > 0u) { p = p + MPH[mb + local].xyz * mw.x; }
      if (nt > 1u) { p = p + MPH[mb + vc + local].xyz * mw.y; }
      if (nt > 2u) { p = p + MPH[mb + 2u*vc + local].xyz * mw.z; }
      if (nt > 3u) { p = p + MPH[mb + 3u*vc + local].xyz * mw.w; }
      /* VAT · rgba8 texel at (v % W, f*rows + v / W), two frames blended, BEFORE the node
         rotation because the delta was baked in the tyre's local frame with the spin removed */
      if (pc.z > 0.5 && F.vatOn > 0.5) {
        let vid = u32(uva.z + 0.5);
        let W = u32(F.vat.x);
        let rows = u32(F.vat.y);
        let x = i32(vid % W);
        let y0 = i32(u32(F.vat.z) * rows + vid / W);
        let y1 = i32(u32(F.vat.w) * rows + vid / W);
        let t0 = textureLoad(VAT, vec2i(x, y0), 0).xyz;
        let t1 = textureLoad(VAT, vec2i(x, y1), 0).xyz;
        let t = mix(t0, t1, F.vatMix);
        p = p + F.vatMin + t * (F.vatMax - F.vatMin);
      }
      /* skin palette or node matrix · four joints, weights from the file */
      var M = mat4x4f(MATS[4u*u32(pa.x)], MATS[4u*u32(pa.x)+1u], MATS[4u*u32(pa.x)+2u], MATS[4u*u32(pa.x)+3u]);
      if (pa.y >= 0.0) {
        let J = JW[2u*i];
        let Wt = JW[2u*i + 1u];
        let so = u32(pa.y);
        let j0 = 4u*(so + u32(J.x + 0.5)); let j1 = 4u*(so + u32(J.y + 0.5));
        let j2 = 4u*(so + u32(J.z + 0.5)); let j3 = 4u*(so + u32(J.w + 0.5));
        M = mat4x4f(MATS[j0],MATS[j0+1u],MATS[j0+2u],MATS[j0+3u]) * Wt.x
          + mat4x4f(MATS[j1],MATS[j1+1u],MATS[j1+2u],MATS[j1+3u]) * Wt.y
          + mat4x4f(MATS[j2],MATS[j2+1u],MATS[j2+2u],MATS[j2+3u]) * Wt.z
          + mat4x4f(MATS[j3],MATS[j3+1u],MATS[j3+2u],MATS[j3+3u]) * Wt.w;
      }
      let wp = (M * vec4f(p, 1.0)).xyz;
      /* rotation part only · a uniformly scaled node keeps its normals after the normalise;
         the non-uniform case (none in this build) would want the inverse transpose */
      let wn = normalize((M * vec4f(n, 0.0)).xyz);
      let wt = vec4f((M * vec4f(T4.xyz, 0.0)).xyz, T4.w);
      let visible = pc.w;`;

  const sceneBufNames = (S) => ({IDX:S.idx.ro, POS:S.pos.ro, NRM:S.nrm.ro, UVA:S.uva.ro, JW:S.jw.ro,
                                 MPH:S.mph.ro, MATS:S.mats.ro, PARTS:S.partsBuf.ro, VAT:S.vatView, F:frameUni});

  function buildShadowPipeline(S, G){
    const vert=tgpu.vertexFn({in:{vi:d.builtin.vertexIndex},
      out:{pos:d.builtin.position, z:d.f32, wp:d.vec3f, vis:d.f32, grow:d.f32}})`{
      ${VERT_BODY}
      let m = mat4x4f(F.s0, F.s1, F.s2, F.s3);
      let cp = m * vec4f(wp, 1.0);
      return Out(cp, cp.z, wp, visible, uva.w);
    }`.$uses(sceneBufNames(S));
    const frag=tgpu.fragmentFn({in:{z:d.f32, wp:d.vec3f, vis:d.f32, grow:d.f32}, out:d.vec4f})`{
      if (in.vis < 0.5) { discard; }
      if (in.grow >= 0.0 && in.grow > F.grow) { discard; }
      if (F.clipOn > 0.5 && U.isEnv < 0.5 && dot(F.clip.xyz, in.wp) + F.clip.w < 0.0) { discard; }
      if (F.dissolve > 0.01 && U.isEnv < 0.5) {
        let cell = floor(in.wp * F.dissolveCell);
        let n = fract(sin(dot(cell, vec3f(12.9898, 78.233, 37.719))) * 43758.5453);
        let grad = smoothstep(F.dissolveX.x, F.dissolveX.y, in.wp.x);
        if (n < F.dissolve * 1.42 - grad * 0.36) { discard; }
      }
      return vec4f(in.z, 0.0, 0.0, 1.0);
    }`.$uses({F:frameUni, U:G.uni});
    return root.createRenderPipeline({
      vertex:vert, fragment:frag, targets:{format:'rgba16float'},
      depthStencil:{format:'depth24plus',depthWriteEnabled:true,depthCompare:'less'},
      /* front faces culled · acne is a lit surface shadowing itself; thin parts (spokes, a
         rotor) are double-sided so they still land in the map */
      primitive:{topology:'triangle-list', cullMode: G.doubleSided ? 'none' : 'front'},
    });
  }

  function buildPipeline(S, G, variant){
    const vert=tgpu.vertexFn({in:{vi:d.builtin.vertexIndex},
      out:{pos:d.builtin.position, n:d.vec3f, wp:d.vec3f, uv:d.vec2f, vd:d.f32,
           bary:d.vec3f, tint:d.vec4f, t:d.vec4f, vis:d.f32, grow:d.f32}})`{
      ${VERT_BODY}
      let m = mat4x4f(F.m0, F.m1, F.m2, F.m3);
      let cp = m * vec4f(wp, 1.0);
      /* vertex pulling draws non-indexed, so the triangle corner is vi % 3 · barycentrics for the
         wireframe cost no extra geometry */
      let corner = in.vi % 3u;
      var bc = vec3f(0.0);
      if (corner == 0u) { bc = vec3f(1.0,0.0,0.0); }
      else if (corner == 1u) { bc = vec3f(0.0,1.0,0.0); }
      else { bc = vec3f(0.0,0.0,1.0); }
      return Out(cp, wn, wp, uva.xy, cp.w, bc, tint, wt, visible, uva.w);
    }`.$uses(sceneBufNames(S));

    /* two targets · colour with linear depth in alpha, and the shaded normal for the post pass */
    const frag=tgpu.fragmentFn({in:{n:d.vec3f, wp:d.vec3f, uv:d.vec2f, vd:d.f32, bary:d.vec3f,
      tint:d.vec4f, t:d.vec4f, vis:d.f32, grow:d.f32, pos:d.builtin.position, ff:d.builtin.frontFacing},
      out:{col:d.vec4f, nrm:d.vec4f}})`{
      /* _GROW · the frame draws itself along its tubes (hero v3): fragments past the threshold do
         not exist yet, and the 3 % of tube just behind the front is a hot orange cut edge · the
         stroke the page drew in SVG continues into the down tube in 3D. grow 2 = off. */
      var growEdge = 0.0;
      if (in.grow >= 0.0 && F.grow < 1.5 && U.isEnv < 0.5) {
        if (in.grow > F.grow) { discard; }
        growEdge = smoothstep(F.grow - 0.055, F.grow - 0.004, in.grow);
      }
      if (in.vis < 0.999) {
        /* a ghosted part keeps its shading and loses pixels on an ORDERED 4x4 Bayer threshold ·
           it needs no back-to-front sorting, and unlike the white-noise hash it started as, a
           regular screen tone reads as translucency instead of as television static. Bayer by the
           standard recursion B4(x,y) = 4*B2(x&1,y&1) + B2(x>>1,y>>1), with B2(x,y) = (2x+3y) mod 4. */
        if (in.vis <= 0.002) { discard; }
        let bp = vec2u(in.pos.xy);
        let bx = bp.x & 3u;
        let by = bp.y & 3u;
        let fine = (2u * (bx & 1u) + 3u * (by & 1u)) % 4u;
        let coarse = (2u * (bx >> 1u) + 3u * (by >> 1u)) % 4u;
        if ((f32(4u * fine + coarse) + 0.5) / 16.0 > in.vis) { discard; }
      }
      /* the section plane · the capped cut is the back face painted flat, gated on the plane
         being active because the double-sided parts also show their backs */
      var cutFace = false;
      let env = U.isEnv > 0.5;
      if (F.clipOn > 0.5 && !env) {
        if (dot(F.clip.xyz, in.wp) + F.clip.w < 0.0) { discard; }
        cutFace = !in.ff;
      }
      var edgeGlow = 0.0;
      if (F.dissolve > 0.01 && !env) {
        let cell = floor(in.wp * F.dissolveCell);
        let n = fract(sin(dot(cell, vec3f(12.9898, 78.233, 37.719))) * 43758.5453);
        let grad = smoothstep(F.dissolveX.x, F.dissolveX.y, in.wp.x);
        let thr = F.dissolve * 1.42 - grad * 0.36;
        if (n < thr) { discard; }
        edgeGlow = smoothstep(thr + 0.16, thr, n);
      }
      /* derivatives and texture taps in UNIFORM control flow · inside a branch they fail
         pipeline creation. discard is a demote, it does not break uniformity. */
      let baryFw = fwidth(in.bary);
      let dpx = dpdx(in.wp);
      let dpy = dpdy(in.wp);
      let dux = dpdx(in.uv);
      let duy = dpdy(in.uv);
      /* KHR_texture_transform · scale, then rotate, then offset */
      let cr = cos(U.uvRot); let sr = sin(U.uvRot);
      let uvs = in.uv * U.uvScale;
      let uv = vec2f(cr*uvs.x - sr*uvs.y, sr*uvs.x + cr*uvs.y) + U.uvOffset;
      let texC = textureSample(BASE, SM, uv);
      let orm  = textureSample(ORM, SM, uv).rgb;
      let nrmT = textureSample(NRMT, SM, uv).rgb*2.0 - vec3f(1.0);
      let occT = textureSample(OCC, SM, uv).r;
      let emiT = textureSample(EMIS, SM, uv).rgb;

      var albedo = U.base.rgb;
      var alpha = U.base.a;
      if (U.hasTex > 0.5) { albedo = albedo * texC.rgb; alpha = alpha * texC.a; }
      if (U.alphaMode > 0.5 && U.alphaMode < 1.5 && alpha < U.cutoff) { discard; }

      var Ng = normalize(in.n);
      if (!in.ff) { Ng = -Ng; }              /* a back face lit as a back face */
      var N = Ng;
      if (U.hasNrm > 0.5) {
        var T = vec3f(0.0);
        var B = vec3f(0.0);
        var ok = false;
        if (abs(in.t.w) > 0.5) {
          /* the file's TANGENT, orthonormalised against the normal; the bitangent's sign is the
             handedness the exporter wrote */
          let t0 = in.t.xyz - Ng*dot(Ng, in.t.xyz);
          if (dot(t0, t0) > 1e-8) { T = normalize(t0); B = cross(Ng, T) * sign(in.t.w); ok = true; }
        } else {
          /* a cotangent frame from screen-space derivatives · no TANGENT attribute needed, and
             it degenerates safely on parts with no UVs */
          let Traw = dpx*duy.y - dpy*dux.y;
          let Braw = dpy*dux.x - dpx*duy.x;
          let tl = length(Traw);
          let bl = length(Braw);
          if (tl > 1e-7 && bl > 1e-7) { T = Traw/tl; B = Braw/bl; ok = true; }
        }
        if (ok) { N = normalize(T*(nrmT.x*U.nrmScale) + B*(nrmT.y*U.nrmScale) + Ng*max(nrmT.z, 0.05)); }
      }
      let V = normalize(F.eye - in.wp);
      let vn = vec3f(dot(N,F.camRight), dot(N,F.camUp), -dot(N,F.camFwd));
      let lin = clamp((in.vd - F.near)/(F.far - F.near), 0.0, 1.0);
      let nrmOut = vec4f(N*0.5 + vec3f(0.5), 1.0);

      if (cutFace) {
        let cut = mix(vec3f(0.80,0.30,0.10), vec3f(0.95,0.45,0.16), max(vn.z,0.0));
        return Out(vec4f(cut, lin), nrmOut);
      }

      /* glTF: factor × texture for roughness (g) and metallic (b); occlusion from its own map,
         or from the ORM's red only when the file points occlusionTexture at that image */
      var rough = clamp(U.rough, 0.03, 1.0);
      var metal = U.metal;
      var occ = 1.0;
      if (U.hasOrm > 0.5) { rough = clamp(rough*orm.g, 0.03, 1.0); metal = clamp(metal*orm.b, 0.0, 1.0); }
      if (U.hasOcc > 0.5) { occ = mix(1.0, occT, U.occStrength); }
      else if (U.ormOcc > 0.5) { occ = mix(1.0, orm.r, U.occStrength); }

      /* per-part tint dyed into the albedo BEFORE lighting so it still takes its shadow · a
         metal takes it more gently: a tint shifts its reflectance, it cannot make it plastic */
      albedo = mix(albedo, in.tint.rgb, in.tint.a*0.86*(1.0 - metal*0.55));
      /* tyre dust · a light sand tint and a duller finish on whatever sits within a hand of
         the ground; metals shrug most of it off */
      let dustA = F.dust * smoothstep(90.0, 8.0, in.wp.y - F.groundY) * (1.0 - metal*0.7);
      albedo = mix(albedo, vec3f(0.58,0.53,0.45), dustA*0.28);
      rough = mix(rough, 0.88, dustA*0.45);

      let mode = F.mode;
      if (mode > 3.5 && mode < 4.5) { return Out(vec4f(vn*0.5+vec3f(0.5), lin), nrmOut); }       /* normals */
      if (mode > 4.5 && mode < 5.5) { return Out(vec4f(envSpec(reflect(-V, N), rough), lin), nrmOut); }   /* debug · studio reflection */
      if (mode > 5.5 && mode < 6.5) { return Out(vec4f(envIrr(N), lin), nrmOut); }                        /* debug · studio irradiance */
      if (mode > 0.5 && mode < 1.5) { return Out(vec4f(matcap(vn, F.theme), lin), nrmOut); }       /* matcap */
      if (mode > 6.5 && mode < 7.5) {                                                              /* wireframe */
        let a3 = smoothstep(vec3f(0.0), baryFw*0.85, in.bary);
        let edge = pow(1.0 - min(a3.x, min(a3.y, a3.z)), 1.6);
        let ink  = mix(vec3f(0.10,0.11,0.14), vec3f(0.55,0.86,1.0), F.inkMode);
        let face = mix(vec3f(0.955,0.955,0.965), vec3f(0.055,0.058,0.070), F.inkMode);
        let lit  = 0.60 + max(vn.z,0.0)*0.42;
        return Out(vec4f(mix(face*lit, ink, edge*0.88), lin), nrmOut);
      }

      /* PCF · nine point samples over one texel of the sun map */
      var shade = 1.0;
      if (F.shadowOn > 0.5) {
        let sm = mat4x4f(F.s0, F.s1, F.s2, F.s3);
        let lp = sm * vec4f(in.wp, 1.0);
        let suv = vec2f(lp.x*0.5+0.5, 0.5-lp.y*0.5);
        if (suv.x > 0.001 && suv.x < 0.999 && suv.y > 0.001 && suv.y < 0.999) {
          let bias = F.shadowBias;
          var lit = 0.0;
          for (var j = -1; j <= 1; j = j + 1) {
            for (var i2 = -1; i2 <= 1; i2 = i2 + 1) {
              let o = vec2f(f32(i2), f32(j)) * (1.0/${SHADOW_RES}.0);
              let sd = textureSampleLevel(SHADOW, SMN, suv + o, 0.0).r;
              lit = lit + select(0.0, 1.0, lp.z - bias <= sd);
            }
          }
          shade = mix(0.10, 1.0, lit/9.0);
        }
      }

      if (mode > 7.5 && mode < 8.5) { return Out(vec4f(vec3f(shade), lin), nrmOut); }                  /* debug · sun shadow term */
      /* ── shading · diffuse and specular kept apart so glass can keep its highlight ── */
      let ndv = max(dot(N, V), 1e-4);
      let ndvG = max(dot(Ng, V), 1e-4);
      let F0 = mix(vec3f(0.04), albedo, metal);
      let diffCol = albedo*(1.0 - metal);
      let coat = clamp(U.clearcoat, 0.0, 1.0);
      let coatR = clamp(U.coatRough, 0.03, 1.0);
      /* the coat's fresnel rides the SMOOTH geometric normal · the twill lives under the lacquer */
      let Fc = 0.04 + 0.96*pow(1.0 - ndvG, 5.0);
      let coatAtt = 1.0 - coat*Fc;
      var diff = vec3f(0.0);
      var spec = vec3f(0.0);
      /* the sun · directional, the only shadow caster. Its intensity is irradiance/π, so the
         diffuse is albedo·I·n·l and the microfacet lobe carries the π */
      {
        let L = normalize(-F.sunDir);
        let ndl = max(dot(N,L), 0.0);
        let H = normalize(V+L);
        let hdv = max(dot(H,V), 0.0);
        let Fs = F0 + (vec3f(1.0)-F0)*pow(1.0-hdv, 5.0);
        let FcL = 0.04 + 0.96*pow(1.0-hdv, 5.0);
        let li = F.sunCol*F.sunI*F.sunGain*shade;
        diff = diff + li*diffCol*ndl*coatAtt;
        spec = spec + li*(ggx(N,V,L,rough)*Fs*ndl*coatAtt + ggx(Ng,V,L,coatR)*FcL*coat*max(dot(Ng,L),0.0))*3.14159265;
      }
      /* the headlight and the studio key · spots from the file, no shadow */
      {
        let s1 = spot(in.wp, F.headPos, F.headDir, F.headI, F.headCos, F.headCosIn, F.spotScale, F.spotRange);
        let s2 = spot(in.wp, F.studioPos, F.studioDir, F.studioI, F.studioCos, F.studioCosIn, F.spotScale, F.spotRange);
        let Ls = array<vec4f,2>(s1, s2);
        let Cs = array<vec3f,2>(F.headCol, F.studioCol);
        for (var k = 0; k < 2; k = k + 1) {
          let L = Ls[k].xyz;
          let w = Ls[k].w;
          if (w > 1e-5) {
            let ndl = max(dot(N,L), 0.0);
            let H = normalize(V+L);
            let hdv = max(dot(H,V), 0.0);
            let Fs = F0 + (vec3f(1.0)-F0)*pow(1.0-hdv, 5.0);
            let FcL = 0.04 + 0.96*pow(1.0-hdv, 5.0);
            let li = Cs[k]*w;
            diff = diff + li*diffCol*ndl*coatAtt;
            spec = spec + li*(ggx(N,V,L,rough)*Fs*ndl*coatAtt + ggx(Ng,V,L,coatR)*FcL*coat*max(dot(Ng,L),0.0))*3.14159265;
          }
        }
      }
      /* the studio · irradiance for the diffuse, the prefiltered dome for the specular (split
         sum), a second lobe for the coat. It comes down with the sun: a night-time bike under
         full room light is the studio again with a colour cast. */
      let amb = F.ambient * F.envStrength * mix(0.35, 1.0, clamp(F.sunI, 0.0, 1.0));
      let so = specOcc(ndv, occ, rough);
      let R = reflect(-V, N);
      let Rc = reflect(-V, Ng);
      diff = diff + diffCol*envIrr(N)*occ*amb*coatAtt;
      spec = spec + (envSpec(R, rough)*envBRDF(F0, rough, ndv)*coatAtt
                   + envSpec(Rc, coatR)*envBRDF(vec3f(0.04), coatR, ndvG)*coat)*so*amb*F.specStrength;
      var emis = U.emissive;
      if (U.hasEmis > 0.5) { emis = emis*emiT; }
      var col = diff + spec + emis;
      /* aerial haze · a macro shot at ground level runs its ground plane out to a horizon, and a
         flat plane with a normal map is at its least convincing exactly there. A real lens loses
         it to depth of field; here it is lost to the page's own paper, which both hides the far
         plane and welds the shot into the page instead of fighting it. Off (hazeAmt 0) elsewhere. */
      if (F.hazeAmt > 0.001 && !(U.isEnv > 0.5 && U.hasEmis > 0.5)) {         /* an emissive environment (the sky) is the haze's colour source, not its subject */
        let hz = clamp((in.vd - F.hazeNear) / max(1.0, F.hazeFar - F.hazeNear), 0.0, 1.0);
        col = mix(col, F.hazeCol.xyz, hz * hz * F.hazeAmt);
      }
      col = mix(col, vec3f(0.30, 0.68, 1.25), edgeGlow * 0.82);
      col = mix(col, vec3f(3.4, 0.95, 0.30), growEdge * growEdge * 0.97);   /* Trail Orange, over-bright and hotter at the very tip */
      col = col + in.tint.rgb * in.tint.a * in.tint.a * 0.5;

      /* the wireframe sweep · lines ahead of the front, material behind it */
      let sweepT = smoothstep(F.sweep + 26.0, F.sweep - 78.0, in.wp.x);
      let sweepEdge = exp(-pow((in.wp.x - F.sweep) / 34.0, 2.0));
      let wireAmt = max(F.wire, 1.0 - sweepT) * (1.0 - U.isEnv);
      if (wireAmt > 0.002) {
        let a3 = smoothstep(vec3f(0.0), baryFw*0.9, in.bary);
        let e  = pow(1.0 - min(a3.x, min(a3.y, a3.z)), 1.5);
        let bp = mix(vec3f(0.008,0.014,0.022), vec3f(0.16,0.60,1.05), e) + vec3f(0.10,0.42,0.80)*e*0.9;
        col = mix(col, bp, wireAmt);
        col = col + vec3f(0.20,0.58,1.0) * sweepEdge * (1.0 - F.wire) * 0.55;
      }
      if (U.alphaMode > 1.5) {
        /* BLEND · premultiplied into its own target; alpha here is the material's, not depth.
           Glass (transmission) keeps its full highlight over a see-through body */
        let a = alpha * (1.0 - U.transmission*0.85);
        let keep = mix(a, 1.0, U.transmission);
        return Out(vec4f((col - spec)*a + spec*keep, a), vec4f(0.0));
      }
      return Out(vec4f(col, lin), nrmOut);
    }`.$uses({U:G.uni, F:frameUni, BASE:G.baseView, NRMT:G.nrmView, ORM:G.ormView, OCC:G.occView, EMIS:G.emisView,
              SM:G.sampler, SHADOW:shadowView, SMN:shadowSampler, ggx, matcap, spot, envSpec, envIrr, envBRDF, specOcc});

    if (variant==='blend'){
      return root.createRenderPipeline({
        vertex:vert, fragment:frag,
        targets:{ col:{format:'rgba16float', blend:{
                    color:{srcFactor:'one', dstFactor:'one-minus-src-alpha', operation:'add'},
                    alpha:{srcFactor:'one', dstFactor:'one-minus-src-alpha', operation:'add'}}},
                  nrm:{format:'rgba16float', writeMask:0} },
        depthStencil:{format:'depth24plus',depthWriteEnabled:false,depthCompare:'less'},
        primitive:{topology:'triangle-list', cullMode:'none'},
      });
    }
    return root.createRenderPipeline({
      vertex:vert, fragment:frag, targets:{ col:{format:'rgba16float'}, nrm:{format:'rgba16float'} },
      depthStencil:{format:'depth24plus',depthWriteEnabled:true,depthCompare:'less'},
      primitive:{topology:'triangle-list', cullMode: (variant==='cut' || G.doubleSided) ? 'none' : 'back'},
    });
  }

  /* ── a GLB on the GPU ─────────────────────────────────────────────────────────────────── */
  const scenes=[];
  async function addScene(scene, o={}){
    const isEnv = o.env ? 1 : 0;
    /* parts = (node, prim) pairs · a mesh shared by 500 nodes is 500 parts with their own vertex
       copies, because the vertex carries the part and the part carries the node */
    const parts=[];
    for (const n of scene.nodes){
      if (n.mesh<0) continue;
      const mesh=scene.meshes[n.mesh];
      mesh.prims.forEach((prim,pi)=>parts.push({node:n, prim, pi, mat:prim.material}));
    }
    /* group by material, contiguous · a material is then ONE draw over a vertex range */
    parts.sort((a,b)=>a.mat-b.mat);
    let V=0, I=0, MT=0;
    for (const p of parts){ V+=p.prim.vcount; I+=p.prim.index.length; MT+=p.prim.vcount*p.prim.targets.length; }
    /* normals and tangents interleave in ONE buffer (two vec4 per vertex) · WebGPU allows eight
       storage buffers in the vertex stage and the renderer already uses all eight */
    const pos=new Float32Array(V*4), nrm=new Float32Array(V*8), uva=new Float32Array(V*4),
          jw=new Float32Array(V*8), mph=new Float32Array(Math.max(1,MT)*4), idx=new Uint32Array(I);
    let vb=0, ib=0, mb=0;
    /* joint palettes live after the node matrices in one buffer · skin s starts at skinOff[s] */
    const N=scene.nodes.length;
    const skinOff=scene.skins.map((s,i)=>N + scene.skins.slice(0,i).reduce((a,k)=>a+k.joints.length,0));
    const totalMats=N + scene.skins.reduce((a,k)=>a+k.joints.length,0);
    parts.forEach((P,pi)=>{
      const p=P.prim, n=P.node;
      P.index=pi; P.first=ib; P.count=p.index.length; P.vbase=vb; P.vcount=p.vcount; P.morphBase=mb/4;
      for (let v=0;v<p.vcount;v++){
        const o=(vb+v)*4, o8=(vb+v)*8;
        pos[o]=p.position[v*3]; pos[o+1]=p.position[v*3+1]; pos[o+2]=p.position[v*3+2]; pos[o+3]=pi;
        if (p.normal){ nrm[o8]=p.normal[v*3]; nrm[o8+1]=p.normal[v*3+1]; nrm[o8+2]=p.normal[v*3+2]; }
        else { nrm[o8+1]=1; }
        nrm[o8+3]=P.mat;
        if (p.tangent){ nrm[o8+4]=p.tangent[v*4]; nrm[o8+5]=p.tangent[v*4+1]; nrm[o8+6]=p.tangent[v*4+2]; nrm[o8+7]=p.tangent[v*4+3]||1; }
        if (p.uv){ uva[o]=p.uv[v*2]; uva[o+1]=p.uv[v*2+1]; }
        uva[o+2]=p.vatId ? p.vatId[v] : 0;
        uva[o+3]=p.grow ? p.grow[v] : -1;      /* _GROW (hero v3) · -1 = no draw order, always drawn */
        const j=(vb+v)*8;
        if (p.joints && p.weights){
          jw[j]=p.joints[v*4]; jw[j+1]=p.joints[v*4+1]; jw[j+2]=p.joints[v*4+2]; jw[j+3]=p.joints[v*4+3];
          jw[j+4]=p.weights[v*4]; jw[j+5]=p.weights[v*4+1]; jw[j+6]=p.weights[v*4+2]; jw[j+7]=p.weights[v*4+3];
        }
      }
      for (let k=0;k<p.index.length;k++) idx[ib+k]=vb+p.index[k];
      p.targets.forEach(t=>{
        if (t) for (let v=0;v<p.vcount;v++){ mph[mb+v*4]=t[v*3]; mph[mb+v*4+1]=t[v*3+1]; mph[mb+v*4+2]=t[v*3+2]; }
        mb+=p.vcount*4;
      });
      vb+=p.vcount; ib+=p.index.length;
    });
    const S={ scene, parts, V, I, tris:I/3, name:scene.name, visible:true,
      pos:storageBuf(d.arrayOf(d.vec4f,V), pos), nrm:storageBuf(d.arrayOf(d.vec4f,V*2), nrm),
      uva:storageBuf(d.arrayOf(d.vec4f,V), uva), jw:storageBuf(d.arrayOf(d.vec4f,V*2), jw),
      mph:storageBuf(d.arrayOf(d.vec4f,Math.max(1,MT)), mph),
      idx:storageBuf(d.arrayOf(d.u32,I), idx),
      matsF32:new Float32Array(totalMats*16), partsF32:new Float32Array(parts.length*16),
      skinOff, totalMats, groups:[], blendParts:[], vat:null, vatView:null,
      tangents: parts.some(P=>P.prim.tangent),
    };
    S.mats=storageBuf(d.arrayOf(d.vec4f,totalMats*4), S.matsF32, true);
    S.partsBuf=storageBuf(d.arrayOf(d.vec4f,parts.length*4), S.partsF32, true);
    /* per-part world centres for the transparent sort, and per-part tint the page can drive */
    S.tint=new Float32Array(parts.length*4);
    S.partByNode=new Map(); parts.forEach(P=>{ const a=S.partByNode.get(P.node.i)||[]; a.push(P); S.partByNode.set(P.node.i,a); });

    /* VAT · rgba8unorm, NOT srgb: it is data. textureLoad in the vertex stage needs no sampler. */
    if (o.vat && o.vat.image){
      const bmp=await createImageBitmap(o.vat.image,{colorSpaceConversion:'none', premultiplyAlpha:'none'});
      const tex=root.createTexture({size:[bmp.width,bmp.height],format:'rgba8unorm'}).$usage('sampled','render');
      tex.write(bmp,{fit:'stretch'});
      S.vatView=tex.createView(); S.vat=o.vat.meta;
    } else {
      const tex=root.createTexture({size:[1,1],format:'rgba8unorm'}).$usage('sampled','render');
      tex.write(await createImageBitmap(new ImageData(new Uint8ClampedArray([0,0,0,255]),1,1)),{fit:'stretch'});
      S.vatView=tex.createView();
    }

    /* one group per material · its own uniform (live factors), its textures, its pipelines */
    const matIds=[...new Set(parts.map(P=>P.mat))];
    const DEF={name:'default', base:new Float32Array([0.8,0.8,0.8,1]), metallic:0, roughness:0.6,
               emissive:new Float32Array(3), emissiveStrength:1, alphaMode:'OPAQUE', alphaCutoff:0.5, doubleSided:false,
               texIndex:-1, nrmIndex:-1, ormIndex:-1, occIndex:-1, emisIndex:-1, nrmScale:1, occStrength:1,
               clearcoat:0, coatRough:0, transmission:0, uvOffset:[0,0], uvScale:[1,1], uvRot:0, channels:[]};
    for (const mi of matIds){
      const M = mi>=0 ? scene.materials[mi] : DEF;
      const gparts=parts.filter(P=>P.mat===mi);
      /* glass (transmission) draws with the blended parts · it has to show what is behind it */
      const blend = M.alphaMode==='BLEND' || (M.transmission||0)>0.01;
      const G={ mi, mat:M, name:M.name, parts:gparts, first:gparts[0].first,
                count:gparts.reduce((a,P)=>a+P.count,0), doubleSided:M.doubleSided, blend };
      const img = ti => scene.texImage ? scene.texImage(ti) : null;
      G.baseView=await loadTex(img(M.texIndex), 'rgba8unorm-srgb', [255,255,255,255]);
      G.nrmView =await loadTex(img(M.nrmIndex), 'rgba8unorm', [128,128,255,255]);
      G.ormView =await loadTex(img(M.ormIndex), 'rgba8unorm', [255,255,255,255]);
      const sepOcc = M.occIndex>=0 && M.occIndex!==M.ormIndex;
      G.occView =await loadTex(sepOcc ? img(M.occIndex) : null, 'rgba8unorm', [255,255,255,255]);
      G.emisView=await loadTex(img(M.emisIndex), 'rgba8unorm-srgb', [255,255,255,255]);
      /* wrap modes from whichever slot has a sampler · Blender writes one sampler for all */
      const smp = scene.texSampler ? scene.texSampler([M.texIndex,M.nrmIndex,M.ormIndex,M.occIndex,M.emisIndex].find(i=>i>=0) ?? -1) : {};
      G.sampler=materialSampler(smp.wrapU, smp.wrapT);
      G.state={ isEnv, base:d.vec4f(...M.base), emissive:d.vec3f(0,0,0), metal:M.metallic, rough:M.roughness,
                hasTex:M.texIndex>=0?1:0, alphaMode: blend?2:(M.alphaMode==='MASK'?1:0),
                cutoff:M.alphaCutoff, nrmScale:M.nrmScale, occStrength:M.occStrength,
                hasNrm:M.nrmIndex>=0?1:0, hasOrm:M.ormIndex>=0?1:0,
                uvScale:d.vec2f(M.uvScale?.[0] ?? 1, M.uvScale?.[1] ?? 1), uvOffset:d.vec2f(M.uvOffset?.[0] ?? 0, M.uvOffset?.[1] ?? 0),
                uvRot:M.uvRot||0, clearcoat:M.clearcoat||0, coatRough:M.coatRough||0, hasOcc:sepOcc?1:0,
                ormOcc:(M.occIndex>=0 && M.occIndex===M.ormIndex)?1:0, hasEmis:M.emisIndex>=0?1:0,
                transmission:M.transmission||0, _p:0 };
      G.uni=root.createUniform(Mat, G.state);
      G.pipeShadow=buildShadowPipeline(S, G);
      if (G.blend){ G.pipeBlend=buildPipeline(S, G, 'blend'); S.blendParts.push(...gparts.map(P=>({P,G}))); }
      else { G.pipe=buildPipeline(S, G, 'opaque'); G.pipeCut=buildPipeline(S, G, 'cut'); }
      S.groups.push(G);
    }
    S.update=()=>updateScene(S);
    scenes.push(S);
    S.update();
    return S;
  }
  function removeScene(S){ const i=scenes.indexOf(S); if(i>=0) scenes.splice(i,1); }

  /* per frame · node worlds, joint palettes, part table, live material factors */
  function updateScene(S){
    const sc=S.scene;
    sc.updateWorld();
    const m=S.matsF32;
    for (const n of sc.nodes) m.set(n.world, n.i*16);
    sc.skins.forEach((sk,i)=> sc.jointMatrices(i, m, S.skinOff[i]*16));
    device.queue.writeBuffer(S.mats.gb, 0, m);
    const p=S.partsF32;
    for (const P of S.parts){
      const o=P.index*16, n=P.node;
      p[o]=n.i; p[o+1]= n.skin>=0 ? S.skinOff[n.skin] : -1; p[o+2]=P.vbase; p[o+3]=P.morphBase;
      const nt=P.prim.targets.length;
      p[o+4]=nt; p[o+5]=P.vcount; p[o+6]=P.prim.vatId?1:0;
      /* presence · 0 hidden, 1 solid, in between a screen-door ghost (see the scene frag).
         A cutaway needs the frame to stop hiding what it contains WITHOUT sorting every part
         into the blend pass, and a stipple at 0.2 reads as glass at this pixel density. */
      p[o+7]= n.hidden ? 0 : (n.presence===undefined ? 1 : n.presence);
      const w=n.weights;
      p[o+8]=nt>0&&w?w[0]:0; p[o+9]=nt>1&&w?w[1]:0; p[o+10]=nt>2&&w?w[2]:0; p[o+11]=nt>3&&w?w[3]:0;
      p[o+12]=S.tint[P.index*4]; p[o+13]=S.tint[P.index*4+1]; p[o+14]=S.tint[P.index*4+2]; p[o+15]=S.tint[P.index*4+3];
    }
    device.queue.writeBuffer(S.partsBuf.gb, 0, p);
    for (const G of S.groups){
      const M=G.mat;
      if (!M.dirty && G.written) continue;
      const es=M.emissiveStrength ?? 1;
      G.state.base=d.vec4f(M.base[0],M.base[1],M.base[2],M.base[3]);
      G.state.emissive=d.vec3f(M.emissive[0]*es,M.emissive[1]*es,M.emissive[2]*es);
      G.state.metal=M.metallic; G.state.rough=M.roughness; G.state.cutoff=M.alphaCutoff ?? 0.5;
      /* the pointer channels the finish chapter drives: normalTexture.scale (the twill fades
         under the paint), clearcoatFactor / clearcoatRoughnessFactor, occlusion strength */
      G.state.nrmScale=M.nrmScale ?? 1; G.state.occStrength=M.occStrength ?? 1;
      G.state.clearcoat=M.clearcoat ?? 0; G.state.coatRough=M.coatRough ?? 0; G.state.transmission=M.transmission ?? 0;
      G.uni.write(G.state); G.written=true; M.dirty=false;
    }
  }

  /* ── rain on the glass ─────────────────────────────────────────────────────────────────────
     A height field of water on a pane in front of the camera: runners in scrolling columns, each
     with a bead and the tapering trail it leaves, plus a field of static beads that fade in and
     out. The post pass refracts the composited frame through its gradient and lights the beads.
     Written for this page · Canvas UI's Droplets carries a Commons Clause (no redistribution in a
     sold template) and its shader is Shadertoy-lineage, so neither could ship here. */
  const rainField=tgpu.fn([d.vec2f,d.f32,d.f32],d.f32)`(p, t, fall) {
    var h = 0.0;
    for (var L = 0u; L < 1u; L = L + 1u) {
      let fl = f32(L);
      let sc = 9.0 + fl * 7.0;                       /* columns across the pane */
      let q = p * sc;
      let colId = floor(q.x);
      let r1 = fract(sin(colId * 127.1 + fl * 311.7) * 43758.5453);
      let r2 = fract(sin(colId * 269.5 + fl * 173.3) * 24634.6345);
      let sp = mix(0.30, 0.85, r1) * fall;
      let y = fract(p.y * 0.85 - t * sp + r2);
      let cx = fract(q.x) - 0.5 + (r2 - 0.5) * 0.30;
      let bead = smoothstep(0.44, 0.05, length(vec2f(cx * 1.7, (y - 0.10) * 3.6)));
      let trail = smoothstep(0.20, 0.0, abs(cx) * 2.6)
                * smoothstep(0.0, 0.10, y - 0.10)
                * (1.0 - smoothstep(0.30, 0.62, y));
      h = h + (bead + trail * 0.22) * mix(1.0, 0.40, fl);
    }
    let g = p * 48.0;
    let gi = floor(g);
    let s1 = fract(sin(dot(gi, vec2f(12.9898, 78.233))) * 43758.5453);
    let s2 = fract(sin(dot(gi, vec2f(39.3467, 11.135))) * 24634.6345);
    let off = (vec2f(s1, s2) - 0.5) * 0.66;
    let dS = length(fract(g) - 0.5 - off);
    let fade = smoothstep(0.0, 0.30, fract(s1 * 6.3 + t * 0.07));
    h = h + smoothstep(0.20, 0.03, dS) * step(0.88, s2) * fade * 0.55;
    return h;
  }`;

  /* ── post · Kestrel's, with the blend composite, a Y-up ground and the normal buffer ───── */
  const Post=d.struct({
    texel:d.vec2f, res:d.vec2f,
    near:d.f32, far:d.f32, aoRadius:d.f32, aoStrength:d.f32,
    camRight:d.vec3f, tanH:d.f32,
    camUp:d.vec3f,    aspect:d.f32,
    camFwd:d.vec3f,   theme:d.f32,
    eye:d.vec3f,      shadow:d.f32,
    f0:d.vec4f,   /* ao · ground shadow · outline · bloom */
    f1:d.vec4f,   /* vignette · grain · time · groundY */
    grade:d.vec4f,/* exposure · contrast · saturation · base exposure */
    s0:d.vec4f, s1:d.vec4f, s2:d.vec4f, s3:d.vec4f,
    gate:d.vec4f, gateAmt:d.f32, gateFeather:d.f32,
    frame:d.vec2f,
    gateMode:d.f32, contact:d.f32, contactR:d.f32, tonemap:d.f32,     /* gate 0 = fade · 1 = darken */
    rain:d.vec4f,   /* amount · fall speed · refraction · spare · the rain-on-glass pass */
  });
  const P={
    rain:d.vec4f(0,1,1,0),
    texel:d.vec2f(1/1000,1/700), res:d.vec2f(1000,700),
    near:10, far:8000, aoRadius:18, aoStrength:1.0,
    camRight:d.vec3f(1,0,0), tanH:0.3, camUp:d.vec3f(0,1,0), aspect:1.6, camFwd:d.vec3f(0,0,-1), theme:1,
    eye:d.vec3f(0,0,1000), shadow:0.55,
    f0:d.vec4f(1,1,0,0), f1:d.vec4f(0,0,0,-280), grade:d.vec4f(0.15,0.10,0.04,0.62),
    s0:d.vec4f(1,0,0,0), s1:d.vec4f(0,1,0,0), s2:d.vec4f(0,0,1,0), s3:d.vec4f(0,0,0,1),
    gate:d.vec4f(0,0,0,0), gateAmt:0, gateFeather:0.14, frame:d.vec2f(0,0), gateMode:0, contact:0.6, contactR:90, tonemap:1,
  };
  const postUni=root.createUniform(Post, P);
  function buildPost(sceneV, blendV, nrmV){
    /* soft contact occlusion at a ground point · taps around the pixel, each geometry hit counts
       by how near and how low it hangs over the point. Works for the analytic plane and for
       geometry that lies on it (the gravel strip). */
    const contactAt=tgpu.fn([d.vec3f,d.vec2f,d.f32],d.f32)`(hp, uv, gdist){
      let gpx = P.res.y / (2.0 * max(gdist, 1.0) * P.tanH);
      let rad = clamp(P.contactR * gpx, 2.0, 56.0);
      let rot = fract(sin(dot(floor(uv*P.res), vec2f(12.9898,78.233)))*43758.5453)*6.2831853;
      var contact = 0.0;
      for (var i = 0; i < 16; i = i + 1) {
        let a = f32(i) * 2.399963 + rot;
        let r = rad * sqrt((f32(i) + 0.5) / 16.0);
        let tuv = uv + vec2f(cos(a),sin(a))*r*P.texel;
        let s = textureSampleLevel(SCENE, SM, tuv, 0.0).a;
        if (s > 0.0001) {
          let sndc = vec2f(tuv.x*2.0-1.0 - P.frame.x, (1.0-tuv.y*2.0) - P.frame.y);
          let sray = P.camRight*sndc.x*P.tanH*P.aspect + P.camUp*sndc.y*P.tanH + P.camFwd;
          let sp = P.eye + sray*(P.near + s*(P.far - P.near));
          let h = sp.y - P.f1.w;
          let dxz = length(sp.xz - hp.xz);
          let d3 = max(length(sp - hp), 1.0);
          /* an occluder counts by how much sky it takes from this point · near and low, and
             a hit that is itself on the ground (the strip) is not an occluder */
          let w = (1.0 - smoothstep(0.0, P.contactR, d3)) * clamp(h/d3, 0.0, 1.0) * smoothstep(4.0, 14.0, h)
                * (1.0 - smoothstep(0.0, P.contactR*0.8, dxz));
          contact = contact + w;
        }
      }
      return clamp(contact/16.0*2.4, 0.0, 1.0);
    }`.$uses({P:postUni, SCENE:sceneV, SM:clampSampler});
    const post=tgpu.fragmentFn({in:{uv:d.vec2f}, out:d.vec4f})`{
      let uv0 = in.uv;
      /* rain on the glass · the frame is refracted through the water's gradient before it is read */
      var rainH = 0.0; var rainN = vec2f(0.0);
      if (P.rain.x > 0.002) {
        /* the water is on a pane BEHIND the product: a near pixel keeps its own edges, a far one
           (the sky, the ridges, the ground beyond) carries the drops. Without this the refraction
           eats the thing the page is about (measured 2026-09-07 · the first cut smeared the bike).
           The gradient is SAMPLED, not taken from dpdx: screen derivatives spike at a drop's edge
           and tore holes in the wheel (measured the same day). */
        let dRaw = textureSampleLevel(SCENE, SM, uv0, 0.0).a;
        let far = mix(1.0, smoothstep(0.018, 0.070, dRaw), step(0.0001, dRaw));
        /* and it is a WINDOW, not a filter: the pane is up in the frame and thins toward the ground */
        let pane = mix(0.16, 1.0, smoothstep(0.70, 0.04, uv0.y));
        let amt = P.rain.x * far * pane;
        if (amt > 0.004) {
          let pp = vec2f(uv0.x * P.aspect, uv0.y);
          let tt = P.f1.z * 0.5;
          let h0 = rainField(pp, tt, P.rain.y);
          let e = 2.2 * P.texel;
          rainN = vec2f(rainField(pp + vec2f(e.x, 0.0), tt, P.rain.y) - h0,
                        rainField(pp + vec2f(0.0, e.y), tt, P.rain.y) - h0) * amt;
          rainH = h0 * amt;
        }
      }
      let uv = clamp(uv0 + rainN * P.rain.z * 0.30, vec2f(0.002), vec2f(0.998));
      /* four taps on the diagonal of a source texel · a real box filter over the supersample */
      let rs = P.texel * 0.5;
      let c = (textureSampleLevel(SCENE, SM, uv + vec2f( rs.x,  rs.y), 0.0)
             + textureSampleLevel(SCENE, SM, uv + vec2f(-rs.x,  rs.y), 0.0)
             + textureSampleLevel(SCENE, SM, uv + vec2f( rs.x, -rs.y), 0.0)
             + textureSampleLevel(SCENE, SM, uv + vec2f(-rs.x, -rs.y), 0.0)) * 0.25;
      let b = (textureSampleLevel(BLEND, SM, uv + vec2f( rs.x,  rs.y), 0.0)
             + textureSampleLevel(BLEND, SM, uv + vec2f(-rs.x,  rs.y), 0.0)
             + textureSampleLevel(BLEND, SM, uv + vec2f( rs.x, -rs.y), 0.0)
             + textureSampleLevel(BLEND, SM, uv + vec2f(-rs.x, -rs.y), 0.0)) * 0.25;
      let dc = c.a;
      var col = c.rgb;
      var alpha = select(0.0, 1.0, dc > 0.0001);
      /* the camera ray for this pixel, lens shift included · geometry is eye + ray·depth */
      let ndc = vec2f(uv.x*2.0-1.0 - P.frame.x, (1.0-uv.y*2.0) - P.frame.y);
      let ray = P.camRight*ndc.x*P.tanH*P.aspect + P.camUp*ndc.y*P.tanH + P.camFwd;

      if (dc > 0.0001) {
        let viewDist = P.near + dc*(P.far - P.near);
        let pxPerMM = P.res.y / (2.0 * viewDist * P.tanH);
        let wp = P.eye + ray*viewDist;
        let n = normalize(textureSampleLevel(NRM, SM, uv, 0.0).xyz*2.0 - vec3f(1.0));
        if (P.f0.x > 0.5) {
          /* normal-oriented occlusion · a tap counts only if it sits ABOVE the surface's own
             plane, so a curved tube no longer shades itself and a spoke meeting the hub does.
             Radius clamped in PIXELS, rotated per pixel so what is left is noise not structure. */
          let rot = fract(sin(dot(floor(uv*P.res), vec2f(12.9898,78.233)))*43758.5453)*6.2831853;
          var occ = 0.0;
          for (var i = 0; i < 24; i = i + 1) {
            /* taps 0..15 at the fine radius, 16..23 at five times it */
            let coarse = select(1.0, 5.0, i >= 16);
            let R = P.aoRadius * coarse;
            let rad = clamp(R * pxPerMM, 2.0, 30.0*coarse);
            let a = f32(i) * 2.399963 + rot;
            let r = rad * sqrt((f32(i % 16) + 0.5) / select(16.0, 8.0, i >= 16));
            let suv = uv + vec2f(cos(a),sin(a))*r*P.texel;
            let s = textureSampleLevel(SCENE, SM, suv, 0.0).a;
            if (s > 0.0001) {
              let sndc = vec2f(suv.x*2.0-1.0 - P.frame.x, (1.0-suv.y*2.0) - P.frame.y);
              let sray = P.camRight*sndc.x*P.tanH*P.aspect + P.camUp*sndc.y*P.tanH + P.camFwd;
              let sp = P.eye + sray*(P.near + s*(P.far - P.near));
              let v = sp - wp;
              let dist = max(length(v), 1e-3);
              let up = dot(n, v/dist);
              let falloff = 1.0 - smoothstep(R*0.5, R*1.6, dist);
              occ = occ + max(up - 0.12, 0.0) * falloff * select(1.0, 0.9, i >= 16);
            }
          }
          let ao = clamp(1.0 - (occ/24.0)*3.0*P.aoStrength, 0.0, 1.0);
          col = col * mix(1.0, ao, 0.9);
          /* geometry lying ON the ground plane (the gravel strip) takes the contact term too */
          if (P.contact > 0.001 && abs(wp.y - P.f1.w) < 12.0) {
            let ct = contactAt(wp, uv, viewDist);
            col = col * (1.0 - ct*P.contact*0.8);
          }
        }
        if (P.f0.z > 0.5) {
          /* outline · a Sobel on the linear depth, thresholded on SLOPE so it is one pixel wide
             at every zoom */
          var gx = 0.0;
          var gy = 0.0;
          for (var j = -1; j <= 1; j = j + 1) {
            for (var i = -1; i <= 1; i = i + 1) {
              let s = textureSampleLevel(SCENE, SM, uv + vec2f(f32(i),f32(j))*P.texel, 0.0).a;
              let sv = select(1.0, s, s > 0.0001);
              let wx = f32(i)*select(1.0, 2.0, j == 0);
              let wy = f32(j)*select(1.0, 2.0, i == 0);
              gx = gx + sv*wx;
              gy = gy + sv*wy;
            }
          }
          let slope = sqrt(gx*gx+gy*gy)*(P.far-P.near)*pxPerMM;
          let e = smoothstep(5.0, 15.0, slope);
          let ink = mix(vec3f(0.05,0.05,0.06), vec3f(0.75,0.86,1.0), P.theme);
          col = mix(col, ink, e*0.85);
        }
      } else {
        /* the ground is not geometry · ray-hit the plane, push that point through the sun
           matrix and read the SAME shadow map the model uses; then a soft CONTACT term from
           whatever geometry hangs just above that point (the tyres' footprint) */
        let dir = normalize(ray);
        if (P.f0.y > 0.5 && abs(dir.y) > 1e-5) {
          let t = (P.f1.w - P.eye.y)/dir.y;
          if (t > 0.0) {
            let hp = P.eye + dir*t;
            let lp = mat4x4f(P.s0,P.s1,P.s2,P.s3) * vec4f(hp, 1.0);
            let suv = vec2f(lp.x*0.5+0.5, 0.5-lp.y*0.5);
            var sh = 0.0;
            if (suv.x > 0.001 && suv.x < 0.999 && suv.y > 0.001 && suv.y < 0.999) {
              for (var i = 0; i < 16; i = i + 1) {
                let a = f32(i)*2.399963;
                let r = 2.6*sqrt((f32(i)+0.5)/16.0)*(1.0/${SHADOW_RES}.0);
                let sd = textureSampleLevel(SHADOW, SMN, suv + vec2f(cos(a),sin(a))*r, 0.0).r;
                sh = sh + select(0.0, 1.0, lp.z - 0.002 > sd);
              }
              sh = sh/16.0;
            }
            var contact = 0.0;
            if (P.contact > 0.001) { contact = contactAt(hp, uv, dot(hp - P.eye, P.camFwd)); }
            col = vec3f(0.0);
            alpha = 1.0 - (1.0 - sh*P.shadow)*(1.0 - contact*P.contact);
          }
        }
      }

      /* the transparent parts, premultiplied, over whatever is behind them · and a blended
         part over the empty page counts as geometry, or a ghosted housing vanishes at its edge */
      col = b.rgb + col*(1.0 - b.a);
      alpha = max(alpha, b.a);

      if (P.f0.w > 0.5) {
        let jit = fract(sin(dot(floor(uv*P.res), vec2f(12.9898,78.233)))*43758.5453)*6.2831853;
        var bl = vec3f(0.0);
        var wsum = 0.0;
        for (var i = 0; i < 32; i = i + 1) {
          let fi = (f32(i)+0.5)/32.0;
          let a = f32(i)*2.399963 + jit;
          let rn = sqrt(fi);
          let r = 30.0*rn;
          let w = exp(-rn*rn*2.1);
          let s = textureSampleLevel(SCENE, SM, uv + vec2f(cos(a),sin(a))*r*P.texel, 0.0).rgb;
          bl = bl + min(max(s - vec3f(0.92), vec3f(0.0)), vec3f(0.75))*w;
          wsum = wsum + w;
        }
        bl = bl/max(wsum, 1e-4);
        col = col + bl*1.6;
        alpha = max(alpha, min(1.0, (bl.r+bl.g+bl.b)*0.55));
      }

      /* the copy gate · a soft rounded region under the chapter's copy. MORAINE is a LIGHT page
         after the hero (paper ground, dark ink), so Kestrel's darken is the wrong direction there:
         the default FADES the render's alpha toward the page instead, whatever colour the page is,
         and the canvas composites over it. The darken survives as mode 1 for a dark chapter. */
      var gateA = 0.0;
      if (P.gateAmt > 0.002) {
        let q = abs(uv - P.gate.xy) - P.gate.zw;
        let sd = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
        let g = 1.0 - smoothstep(-0.01, P.gateFeather, sd);
        gateA = g * P.gateAmt;
      }

      /* exposure, then the view transform · 1 = AgX (default), 2 = ACES, 0 = the old soft knee */
      col = col * exp2(P.grade.x*1.6) * P.grade.w;
      if (P.tonemap > 1.5) { col = aces(col); }
      else if (P.tonemap > 0.5) { col = agx(col); }
      else { col = col / (1.0 + col*0.24); }
      /* the darken gate works on DISPLAY values · under a view transform that lifts shadows a
         scene-linear dim is not a dim */
      if (P.gateMode > 0.5 && gateA > 0.0) {
        let lum0 = dot(col, vec3f(0.2126,0.7152,0.0722));
        col = mix(col, mix(vec3f(lum0), col, 0.35) * 0.13, gateA);
        gateA = 0.0;
      }
      col = (col - vec3f(0.5))*(1.0 + P.grade.y) + vec3f(0.5);
      let lum = dot(col, vec3f(0.2126,0.7152,0.0722));
      col = mix(vec3f(lum), col, 1.0 + P.grade.z);
      /* the beads catch the light · a rim from the gradient and a small specular, so the water reads
         as sitting ON the glass rather than as a smear of the picture behind it */
      if (P.rain.x > 0.002) {
        let rim = clamp(length(rainN) * 22.0, 0.0, 1.0);
        let n3 = normalize(vec3f(rainN * 46.0, 1.0));
        let spec = pow(max(dot(n3, normalize(vec3f(-0.35, 0.72, 0.60))), 0.0), 26.0);
        let lit = clamp(smoothstep(0.05, 0.55, rainH), 0.0, 1.0);
        col = col + (vec3f(0.32, 0.38, 0.50) * rim * 0.30 + vec3f(0.82, 0.88, 1.0) * spec * 0.45) * lit;
      }
      col = max(col, vec3f(0.0));
      var outc = srgb(col);
      if (P.f1.x > 0.5) {
        let v = 1.0 - smoothstep(0.42, 1.02, length((uv-vec2f(0.5))*vec2f(P.aspect,1.0)));
        outc = outc * mix(1.0, v, 0.75);
        /* geometry keeps its alpha · only the backdrop fades at the edges */
        let isGeo = select(0.0, 1.0, dc > 0.0001 || b.a > 0.001);
        alpha = alpha * mix(mix(1.0, mix(0.35,1.0,v), 0.9), 1.0, isGeo);
      }
      if (P.f1.y > 0.5) {
        let n = fract(sin(dot(uv*P.res + vec2f(P.f1.z*37.0), vec2f(12.9898,78.233)))*43758.5453);
        outc = outc + vec3f(n-0.5)*0.05;
      }
      alpha = alpha * (1.0 - gateA);          /* fade mode · premultiplied, so the colour goes with it */
      return vec4f(clamp(outc,vec3f(0.0),vec3f(1.0))*alpha, alpha);
    }`.$uses({P:postUni, SCENE:sceneV, BLEND:blendV, NRM:nrmV, SM:clampSampler, SHADOW:shadowView, SMN:shadowSampler, srgb, aces, agx, contactAt, rainField});
    return root.createRenderPipeline({vertex:fsVert, fragment:post, targets:{format:FORMAT}});
  }

  let depthTex=null, depthView=null, sceneTex=null, sceneView=null, sceneSampled=null,
      blendTex=null, blendView=null, blendSampled=null, nrmTex=null, nrmView=null, nrmSampled=null, dw=0, dh=0, postPipe=null;
  const SS_2X=1.5, SS_1X=2.0; let SS=SS_2X;
  function ensureTargets(cw,ch){
    const maxD=(limits && limits.maxTextureDimension2D)||8192;
    const want=(devicePixelRatio||1)>=1.75 ? SS_2X : SS_1X;
    SS=Math.max(1, Math.min(want, maxD/Math.max(cw,ch,1)));
    const w=Math.round(cw*SS), h=Math.round(ch*SS);
    if (depthTex && dw===w && dh===h) return;
    if (depthTex) depthTex.destroy();
    if (sceneTex) root.unwrap(sceneTex).destroy();
    if (blendTex) root.unwrap(blendTex).destroy();
    if (nrmTex) root.unwrap(nrmTex).destroy();
    depthTex=device.createTexture({size:[w,h],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT});
    depthView=depthTex.createView();
    sceneTex=root.createTexture({size:[w,h],format:'rgba16float'}).$usage('sampled','render');
    sceneView=root.unwrap(sceneTex).createView(); sceneSampled=sceneTex.createView();
    blendTex=root.createTexture({size:[w,h],format:'rgba16float'}).$usage('sampled','render');
    blendView=root.unwrap(blendTex).createView(); blendSampled=blendTex.createView();
    nrmTex=root.createTexture({size:[w,h],format:'rgba16float'}).$usage('sampled','render');
    nrmView=root.unwrap(nrmTex).createView(); nrmSampled=nrmTex.createView();
    dw=w; dh=h;
    P.texel=d.vec2f(1/w,1/h); P.res=d.vec2f(w,h);
    postPipe=buildPost(sceneSampled, blendSampled, nrmSampled);     /* $uses bakes the views in */
    blendCleared=false;
  }

  /* ── the camera rig · a critically damped spring on position, orientation, fov and shift ──
     An exponential lerp is fastest the moment the target jumps, which is exactly when a chapter
     changes. A spring starts slow, carries momentum and settles without overshoot. */
  const cam={
    pos:[0,300,1400], q:[0,0,0,1], yfov:0.6, fx:0, fy:0, znear:10, zfar:0,
    T:{pos:[0,300,1400], q:[0,0,0,1], yfov:0.6, fx:0, fy:0, znear:10, zfar:0},
    V:{pos:[0,0,0], q:[0,0,0,0], yfov:0, fx:0, fy:0},
    omega:14, snapNext:true,
    target(view, snap=false){
      const T=cam.T;
      if (view.world){ const W=view.world; T.pos=[W[12],W[13],W[14]]; T.q=quatFromMat(W); }
      if (view.pos) T.pos=view.pos.slice();
      if (view.q) T.q=view.q.slice();
      if (view.yfov!=null) T.yfov=view.yfov;
      if (view.fx!=null) T.fx=view.fx; if (view.fy!=null) T.fy=view.fy;
      if (view.znear!=null) T.znear=view.znear; if (view.zfar!=null) T.zfar=view.zfar;
      if (snap) cam.snapNext=true;
    },
    step(dt){
      const T=cam.T, V=cam.V;
      if (cam.snapNext){
        cam.pos=T.pos.slice(); cam.q=T.q.slice(); cam.yfov=T.yfov; cam.fx=T.fx; cam.fy=T.fy;
        V.pos=[0,0,0]; V.q=[0,0,0,0]; V.yfov=0; V.fx=0; V.fy=0; cam.snapNext=false;
      }
      const k=cam.omega, c=2*Math.sqrt(k);
      const sp=(x,v,t)=>{ const a=-k*(x-t)-c*v; const v2=v+a*dt; return [x+v2*dt, v2]; };
      for (let i=0;i<3;i++){ const r=sp(cam.pos[i],V.pos[i],T.pos[i]); cam.pos[i]=r[0]; V.pos[i]=r[1]; }
      /* shortest path · spring the components toward whichever sign of the target is nearer */
      let dot=0; for (let i=0;i<4;i++) dot+=cam.q[i]*T.q[i];
      const sg=dot<0?-1:1;
      for (let i=0;i<4;i++){ const r=sp(cam.q[i],V.q[i],T.q[i]*sg); cam.q[i]=r[0]; V.q[i]=r[1]; }
      const L=Math.hypot(...cam.q)||1; for (let i=0;i<4;i++) cam.q[i]/=L;
      let r=sp(cam.yfov,V.yfov,T.yfov); cam.yfov=r[0]; V.yfov=r[1];
      r=sp(cam.fx,V.fx,T.fx); cam.fx=r[0]; V.fx=r[1];
      r=sp(cam.fy,V.fy,T.fy); cam.fy=r[0]; V.fy=r[1];
      cam.znear=T.znear; cam.zfar=T.zfar;
    },
  };

  /* ── lights · read from the file each frame, intensities live from the pointer channels ── */
  const lights={ sun:null, head:null, studio:null, auto:true, lastSun:-1,
    sunScale:1, headScale:1, studioScale:1, sunFull:1, warned:new Set() };
  /* the renderer expects RAW watts (sun W/m² ~ 0..3, spot W ~ 10..2000). A SPEC-mode export
     writes sun*683 and spot*683/4pi, and a mistyped lamp can be anything · convert what looks
     like SPEC, cap the rest, and say so once, rather than render a white page */
  function unitFix(L){
    if (!L) return L;
    let I=L.intensity;
    if (L.type==='directional'){ if (I>20) I=I/683; I=Math.min(I, 8); }
    else { if (I>2e4) I=I*4*Math.PI/683; I=Math.min(I, 5000); }
    if (I!==L.intensity && !lights.warned.has(L.name)){
      console.warn(`light ${L.name}: intensity ${L.intensity} read as ${I.toFixed(3)} (SPEC units or out of range · export with RAW)`);
      lights.warned.add(L.name);
    }
    L.intensity=I; return L;
  }
  function readLights(){
    if (!lights.auto) return;
    for (const S of scenes){
      const sc=S.scene;
      const sun=unitFix(sc.lightState('Sun')), head=unitFix(sc.lightState('Headlight')), st=unitFix(sc.lightState('Studio'));
      if (sun && !lights.sunLock) lights.sun=sun;
      if (head && !lights.headLock) lights.head=head;
      if (st && !lights.studioLock) lights.studio=st;
      /* a file with other names (contact.glb's Light_Contact) still gets lit · first of each type */
      if (!lights.sun){ const L=sc.lights.find(l=>l.type==='directional'); if (L) lights.sun=unitFix(sc.lightState(L.name)); }
      if (!lights.head && !lights.headLock){ const L=sc.lights.find(l=>l.type==='spot'); if (L) lights.head=unitFix(sc.lightState(L.name)); }
    }
  }
  function applyLights(){
    const su=lights.sun;
    if (su){ F.sunDir=d.vec3f(...su.dir); F.sunI=su.intensity*lights.sunScale; F.sunCol=d.vec3f(...su.color); }
    const setSpot=(L, key, scale)=>{
      if (!L){ F[key+'I']=0; return; }
      F[key+'Pos']=d.vec3f(...L.pos); F[key+'Dir']=d.vec3f(...L.dir); F[key+'I']=L.intensity*scale;
      F[key+'Col']=d.vec3f(...L.color); F[key+'Cos']=Math.cos(L.outer); F[key+'CosIn']=Math.cos(L.inner);
    };
    setSpot(lights.head,'head',lights.headScale); setSpot(lights.studio,'studio',lights.studioScale);
    /* the page ground follows the sun · written only when it moves, a style write per frame is
       a layout invalidation per frame */
    /* 0..1 for the page · the file's sun is in W/m² (RAW), `sunFull` is what counts as daylight */
    const sv=Math.round(clampf(F.sunI/(lights.sunFull||1),0,1)*1000)/1000;
    if (sv!==lights.lastSun){
      lights.lastSun=sv;
      if (opts.onSun) opts.onSun(sv); else document.documentElement.style.setProperty('--sun', String(sv));
    }
    /* the studio's key softbox follows the sun's azimuth · highlight and shadow agree */
    const keyAz=Math.atan2(KEY_DIR[0], KEY_DIR[2]);
    const sunAz=Math.atan2(-F.sunDir.x, -F.sunDir.z);
    F.envRot = keyAz - sunAz;
  }

  /* ── frame ── */
  let W=2, H=2, fps=0, frames=0, fpsT=performance.now(), last=performance.now(), cpuMs=0, draws=0;
  let lastVP=null, shadowCentre=null, shadowHalf=null, gateAmt=0, gateBox=null, camName=null;
  const settings={ clip:null, dissolve:0, sweep:99999, wire:0, mode:0, theme:1, ambient:1,
    groundY:-280, vatFrame:0, vatOn:false, shadow:true, ao:true, groundShadow:true, outline:false,
    bloom:false, vignette:false, grain:false, gate:null, gateAmt:0, gateFeather:0.14, gateMode:0, gateTarget:0.85,
    exposure:0.15, contrast:0.10, saturation:0.04, groundShadowAmt:0.55, aoRadius:18, spotScale:0.0008, spotRange:600,
    hazeCol:[0.82,0.79,0.74], hazeNear:400, hazeFar:1600, hazeAmt:0,
    /* the realism pass · base exposure into ACES, studio strength, dust, the contact shadow */
    ev:0.62, tonemap:1, envStrength:1, specStrength:1, dust:0.25, contact:0.6, contactRadius:90,
    /* the file's sun is 1 W/m² at the hero end · the shading gains it so the shadow-casting key
       leads the studio dome; `--sun` for the page is computed from the ungained value */
    sunGain:3.5, shadowBias:0.0009, grow:2, rain:0, rainFall:1, rainRefract:1 };

  function frame(now=performance.now()){
    const t0=performance.now();
    const dt=Math.min(0.05,(now-last)/1000); last=now;
    const dpr=Math.min(devicePixelRatio||1,2);
    const cw=canvas.clientWidth||innerWidth, ch=canvas.clientHeight||innerHeight;
    W=Math.max(2,Math.round(cw*dpr)); H=Math.max(2,Math.round(ch*dpr));
    if (canvas.width!==W||canvas.height!==H){ canvas.width=W; canvas.height=H; }
    ensureTargets(W,H);

    for (const S of scenes) if (S.visible) S.update();
    readLights(); applyLights();
    cam.step(dt);

    /* the near plane follows the camera · a fixed one slices a macro shot open */
    const b = scenes.length ? scenes[0].scene.bounds() : {centre:[0,0,0], radius:1000};
    const dist=Math.hypot(cam.pos[0]-b.centre[0],cam.pos[1]-b.centre[1],cam.pos[2]-b.centre[2]);
    const nearP=clampf(Math.max(cam.znear||0, dist*0.02), 1.5, 80);
    let farP=Math.max(nearP*60, cam.zfar||0, dist + b.radius*3 + 1500);
    for (const S of scenes){ if (!S.visible || S===scenes[0]) continue; const bb=S.scene.bounds(); if (!bb) continue;
      const dd=Math.hypot(cam.pos[0]-bb.centre[0],cam.pos[1]-bb.centre[1],cam.pos[2]-bb.centre[2]); farP=Math.max(farP, dd + bb.radius*1.05); }
    /* the linear depth rides the scene target's fp16 alpha as (vd-near)/(far-near): a 6 km sky sphere put the far
       plane at 10.9 km and a macro's 0.5 m of depth at 4e-5, a subnormal, and the post pass read the bike as
       empty page (the whole bike paper-white at the contact, finish and control macros · teardown 2026-09-06).
       The page scales the sky and the ridges to within 60 m at load; the far plane is capped to match. */
    farP=Math.min(farP, 120000);
    const Wc=worldFromPosQuat(cam.pos, cam.q);
    const Vm=viewFromWorld(Wc);
    const aspect=W/H;
    const Pm=projection(cam.yfov, aspect, nearP, farP, cam.fx, cam.fy);
    const VP=M4.mul(Pm, Vm); lastVP=VP;
    const right=[Wc[0],Wc[1],Wc[2]], up=[Wc[4],Wc[5],Wc[6]], fwd=[-Wc[8],-Wc[9],-Wc[10]];

    /* the sun's shadow frustum · centred on the scene, or wherever the page says (a macro
       chapter wants a tight map over the contact patch) */
    const sc=shadowCentre||b.centre, sh=shadowHalf||Math.max(400, b.radius*1.05);
    const sunDir=[F.sunDir.x,F.sunDir.y,F.sunDir.z];
    const sm=lightMatrix(sunDir, sc, sh, sh*6);

    F.m0=v4(d,VP,0); F.m1=v4(d,VP,4); F.m2=v4(d,VP,8); F.m3=v4(d,VP,12);
    F.s0=v4(d,sm,0); F.s1=v4(d,sm,4); F.s2=v4(d,sm,8); F.s3=v4(d,sm,12);
    F.eye=d.vec3f(...cam.pos); F.near=nearP; F.far=farP;
    F.camRight=d.vec3f(...right); F.camUp=d.vec3f(...up); F.camFwd=d.vec3f(...fwd);
    F.tanH=Math.tan(cam.yfov/2); F.aspect=aspect;
    const st=settings;
    if (st.clip){ F.clip=d.vec4f(...st.clip); F.clipOn=1; } else F.clipOn=0;
    F.dissolve=st.dissolve; F.sweep=st.sweep; F.wire=st.wire; F.mode=st.mode; F.theme=st.theme; F.inkMode=st.inkMode ?? 0; F.grow=st.grow ?? 2;
    F.ambient=st.ambient; F.viewW=W*SS; F.time=now*0.001; F.groundY=st.groundY;
    F.shadowOn=st.shadow?1:0; F.spotScale=st.spotScale; F.spotRange=st.spotRange;
    F.hazeAmt=st.hazeAmt; F.hazeNear=st.hazeNear; F.hazeFar=st.hazeFar;
    F.hazeCol=d.vec4f(st.hazeCol[0], st.hazeCol[1], st.hazeCol[2], 0);
    F.dust=st.dust; F.envStrength=st.envStrength; F.specStrength=st.specStrength; F.sunGain=st.sunGain; F.shadowBias=st.shadowBias;
    F.dissolveCell=clampf(220/Math.max(60,dist), 0.02, 2.0);
    F.dissolveX=d.vec2f(b.min?b.min[0]:-900, b.max?b.max[0]:900);
    /* the VAT frame · fractional, two texels blended */
    const vs=scenes.find(S=>S.vat);
    if (vs && st.vatOn){
      const m=vs.vat, f=clampf(st.vatFrame, 0, m.frames-1), f0=Math.floor(f), f1=Math.min(m.frames-1, f0+1);
      F.vat=d.vec4f(m.width, m.rows, f0, f1); F.vatMix=f-f0; F.vatOn=1;
      F.vatMin=d.vec3f(...m.min); F.vatMax=d.vec3f(...m.max);
    } else F.vatOn=0;
    frameUni.write(F);

    P.camRight=d.vec3f(...right); P.camUp=d.vec3f(...up); P.camFwd=d.vec3f(...fwd);
    P.eye=d.vec3f(...cam.pos); P.near=nearP; P.far=farP; P.tanH=Math.tan(cam.yfov/2); P.aspect=aspect;
    P.theme=st.theme; P.shadow=st.groundShadowAmt; P.aoRadius=st.aoRadius;
    P.f0=d.vec4f(st.ao?1:0, st.groundShadow?1:0, st.outline?1:0, st.bloom?1:0);
    P.f1=d.vec4f(st.vignette?1:0, st.grain?1:0, now*0.001, st.groundY);
    P.rain=d.vec4f(st.rain ?? 0, st.rainFall ?? 1, st.rainRefract ?? 1, 0);
    P.grade=d.vec4f(st.exposure, st.contrast, st.saturation, st.ev);
    P.contact=st.contact; P.contactR=st.contactRadius; P.tonemap=st.tonemap;
    /* the gate eases toward wherever the chapter's copy sits, and out when there is none */
    gateAmt += ((st.gate ? st.gateTarget : 0) - gateAmt) * Math.min(1, dt*5);
    if (st.gate) gateBox=st.gate;
    P.gate = gateBox ? d.vec4f(...gateBox) : d.vec4f(0,0,0,0);
    P.gateAmt=gateAmt; P.gateFeather=st.gateFeather; P.frame=d.vec2f(cam.fx, cam.fy); P.gateMode=st.gateMode;
    P.s0=v4(d,sm,0); P.s1=v4(d,sm,4); P.s2=v4(d,sm,8); P.s3=v4(d,sm,12);
    postUni.write(P);

    /* ── passes ── */
    draws=0;
    let first=true;
    for (const S of scenes){ if(!S.visible) continue; for (const G of S.groups){
      if (G.blend) continue;
      G.pipeShadow
        .withColorAttachment({view:shadowTarget, clearValue:[1,0,0,1], loadOp:first?'clear':'load', storeOp:'store'})
        .withDepthStencilAttachment({view:shadowDepth, depthClearValue:1, depthLoadOp:first?'clear':'load', depthStoreOp:'store'})
        .draw(G.count, 1, G.first);
      first=false; draws++;
    }}
    if (first){   /* nothing cast · clear the map or the ground reads a stale shadow */
      scenes[0]?.groups[0]?.pipeShadow.withColorAttachment({view:shadowTarget, clearValue:[1,0,0,1], loadOp:'clear', storeOp:'store'})
        .withDepthStencilAttachment({view:shadowDepth, depthClearValue:1, depthLoadOp:'clear', depthStoreOp:'store'}).draw(0);
    }
    const cut=!!st.clip;
    first=true;
    for (const S of scenes){ if(!S.visible) continue; for (const G of S.groups){
      if (G.blend) continue;
      (cut?G.pipeCut:G.pipe)
        .withColorAttachment({ col:{view:sceneView, clearValue:[0,0,0,0], loadOp:first?'clear':'load', storeOp:'store'},
                               nrm:{view:nrmView, clearValue:[0.5,0.5,0.5,0], loadOp:first?'clear':'load', storeOp:'store'} })
        .withDepthStencilAttachment({view:depthView, depthClearValue:1, depthLoadOp:first?'clear':'load', depthStoreOp:'store'})
        .draw(G.count, 1, G.first);
      first=false; draws++;
    }}
    /* transparent parts · back to front by the part's world centre, into their own target */
    const blend=[];
    for (const S of scenes){ if(!S.visible) continue; for (const {P:Pt,G} of S.blendParts){
      const n=Pt.node; if (n.hidden) continue;
      const c=[(Pt.prim.bmin[0]+Pt.prim.bmax[0])/2,(Pt.prim.bmin[1]+Pt.prim.bmax[1])/2,(Pt.prim.bmin[2]+Pt.prim.bmax[2])/2];
      const wc=M4.xformPoint(n.world, c);
      const dz=(wc[0]-cam.pos[0])*fwd[0]+(wc[1]-cam.pos[1])*fwd[1]+(wc[2]-cam.pos[2])*fwd[2];
      blend.push({Pt,G,dz});
    }}
    blend.sort((a,b)=>b.dz-a.dz);
    let firstB=true;
    for (const {Pt,G} of blend){
      G.pipeBlend
        .withColorAttachment({ col:{view:blendView, clearValue:[0,0,0,0], loadOp:firstB?'clear':'load', storeOp:'store'},
                               nrm:{view:nrmView, loadOp:'load', storeOp:'store'} })
        .withDepthStencilAttachment({view:depthView, depthClearValue:1, depthLoadOp: first?'clear':'load', depthStoreOp:'store'})
        .draw(Pt.count, 1, Pt.first);
      firstB=false; draws++;
    }
    if (firstB && scenes[0]?.groups[0]){
      /* no transparent parts this frame · the target still has to be cleared */
      const G=scenes.flatMap(S=>S.groups).find(g=>g.pipeBlend);
      if (G) G.pipeBlend.withColorAttachment({ col:{view:blendView, clearValue:[0,0,0,0], loadOp:'clear', storeOp:'store'},
                                             nrm:{view:nrmView, loadOp:'load', storeOp:'store'} })
              .withDepthStencilAttachment({view:depthView, depthClearValue:1, depthLoadOp:'load', depthStoreOp:'store'}).draw(0);
      else if (!blendCleared){ /* a scene with no BLEND material at all · clear once via a raw pass */
        const enc=device.createCommandEncoder();
        enc.beginRenderPass({colorAttachments:[{view:blendView, clearValue:[0,0,0,0], loadOp:'clear', storeOp:'store'}]}).end();
        device.queue.submit([enc.finish()]); blendCleared=true;
      }
    }
    postPipe.withColorAttachment({view:ctx.getCurrentTexture().createView(), clearValue:[0,0,0,0], loadOp:'clear', storeOp:'store'}).draw(3);
    root['~unstable']?.flush?.();
    draws++;

    frames++; cpuMs=performance.now()-t0;
    if (now-fpsT>500){ fps=Math.round(frames*1000/(now-fpsT)); frames=0; fpsT=now; }
  }
  let blendCleared=false;

  /* ── the surface _scene.js drives ─────────────────────────────────────────────────────── */
  const bykey = (key) => scenes.find(S=>S.name===key);
  const api={
    /* a GLB by key · every node then carries {glb:key, name}; a missing file is a warning, not a
       dead page (drivetrain.glb may land later than the rest) */
    async load(key, url, o={}){
      let bytes;
      try { const r=await fetch(url); if(!r.ok) throw new Error(r.status+' '+url); bytes=new Uint8Array(await r.arrayBuffer()); }
      catch(e){ console.warn('load', key, e.message); return null; }
      const scene=parseGLB(bytes, key);
      let vat=null;
      if (o.vat && o.vat.png){
        try { const meta = o.vat.meta || await (await fetch(o.vat.png.replace(/\.png$/i,'.json'))).json();
              vat={ image: await (await fetch(o.vat.png)).blob(), meta }; }
        catch(e){ console.warn('vat', e.message); }
      }
      if (scene.ignoredPointers.length) console.warn(key, 'ignored pointers', scene.ignoredPointers);
      return addScene(scene, { vat, env: !!o.env });
    },
    /* nodes only · filter(node) gets {glb, name, kind:'node', ...}; materials, lights and cameras
       are timed by setPointerTime / camera */
    setTime(filter, seconds){
      let n=0;
      for (const S of scenes) n += S.scene.sampleAll(T => (T.kind==='node' && filter(T)) ? seconds : null);
      return n;
    },
    /* 'lights' = every KHR light's channels; otherwise a material (or light/camera) by NAME */
    setPointerTime(name, seconds){
      let n=0;
      for (const S of scenes){
        const sc=S.scene;
        if (name==='lights'){ sc.lights.forEach(L=>{ if(L.channels.length){ sc.sampleTarget(L, seconds); n++; } }); continue; }
        for (const T of [...sc.materials, ...sc.lights, ...sc.cameras]) if (T.name===name && T.channels.length){ sc.sampleTarget(T, seconds); n++; }
      }
      return n;
    },
    setMorph(nodeName, weights){ for (const S of scenes) if (S.scene.setMorphs(nodeName, weights)) return true; return false; },
    /* bind ONE named light from ONE file to a slot and stop the auto reader touching it. The macro
       chapters need this: a tyre 250 mm across cannot be lit by a studio spot aimed at a whole bike
       four metres away · it reads as a white blob however dark the rubber is. Pass name=null to
       hand the slot back to the reader. */
    light(slot, sceneKey, name){
      if (!name){ lights[slot+'Lock']=false; return true; }
      const S=scenes.find(x=>x.name===sceneKey); if(!S) return false;
      const L=unitFix(S.scene.lightState(name)); if(!L) return false;
      lights[slot]=L; lights[slot+'Lock']=true; return true;
    },
    /* multiplies the REST scale of every node whose name matches · the 40 mm tyre chip */
    scale(re, v){
      const test = re instanceof RegExp ? (s=>re.test(s)) : (s=>s===re);
      let n=0;
      for (const S of scenes) for (const N of S.scene.nodes) if (test(N.name)){ N.scaleMul=[v[0],v[1],v[2]]; N.dirty=true; n++; }
      return n;
    },
    /* a rotation AFTER the rest rotation, in the node's own frame · Steer about its local Y */
    pose(nodeName, q){
      for (const S of scenes){ const N=S.scene.byName.get(nodeName); if(N){ N.rotPost=Float32Array.from(q); N.dirty=true; return true; } }
      return false;
    },
    /* the file's camera at that time, sprung between cameras · drift orbits a few degrees about
       the point on the camera's axis nearest the model, so the pointer never loses the subject */
    camera(name, seconds=null, o={}){
      for (const S of scenes){
        const sc=S.scene;
        const c=sc.cameras.find(c=>c.name===name || sc.nodes[c.node]?.name===name);
        if (!c) continue;
        if (seconds!=null){ sc.sampleTarget(c, seconds); if (c.node>=0) sc.sampleNode(c.node, seconds); sc.updateWorld(); }
        const v=sc.cameraView(c.name); if(!v) return false;
        let Wm=v.world;
        if (o.drift && (o.drift[0]||o.drift[1])){
          const b=sc.bounds(), e=v.eye, f=v.fwd;
          const along=Math.max(200, (b.centre[0]-e[0])*f[0]+(b.centre[1]-e[1])*f[1]+(b.centre[2]-e[2])*f[2]);
          const pv=[e[0]+f[0]*along, e[1]+f[1]*along, e[2]+f[2]*along];
          const yaw=-o.drift[0]*3*Math.PI/180, pitch=-o.drift[1]*2*Math.PI/180;
          const Ry=M4.fromTRS([0,0,0], quatAxis([0,1,0], yaw), [1,1,1]);
          const Rx=M4.fromTRS([0,0,0], quatAxis(v.right, pitch), [1,1,1]);
          const T1=M4.fromTRS(pv,[0,0,0,1],[1,1,1]), T0=M4.fromTRS([-pv[0],-pv[1],-pv[2]],[0,0,0,1],[1,1,1]);
          Wm=M4.mul(T1, M4.mul(Ry, M4.mul(Rx, M4.mul(T0, Wm))));
        }
        const snap = o.snap || camName===null;
        camName=c.name;
        cam.target({world:Wm, yfov:v.yfov, znear:v.znear, zfar:v.zfar, fx:o.shift?o.shift[0]:0, fy:o.shift?o.shift[1]:0}, snap);
        return true;
      }
      return false;
    },
    setVATFrame(f){ settings.vatFrame=f; settings.vatOn=true; },
    /* [l, t, r, b] in 0..1 screen space, or null · {mode:'fade'|'dim', amt} · fade (default) lets the
       page ground through under the copy, dim is Kestrel's darken for a dark chapter */
    gate(rect, o={}){
      settings.gateMode = o.mode==='dim' ? 1 : 0;
      settings.gateTarget = o.amt ?? 0.85;
      if (!rect){ settings.gate=null; return; }
      const cx=(rect[0]+rect[2])/2, cy=(rect[1]+rect[3])/2, hw=(rect[2]-rect[0])/2, hh=(rect[3]-rect[1])/2;
      settings.gate=[cx, cy, Math.max(0.02,hw), Math.max(0.02,hh)];
    },
    annotate(){ /* the dimension chain is drawn by the page's 2D layer off R.project · nothing here yet */ },
  };

  const R={
    ...api,
    root, device, canvas, scenes, cam, lights, settings, F, P, M4, quatAxis,
    addScene, removeScene, frame, scene: bykey,
    set(o){ Object.assign(settings, o); return R; },
    setShadowFrustum(centre, half){ shadowCentre=centre; shadowHalf=half; },
    /* the file's camera, sampled wherever the page left its node · snap for the first frame */
    useCamera(scene, name, snap=false){
      const v=scene.cameraView(name); if(!v) return false;
      cam.target({world:v.world, yfov:v.yfov, znear:v.znear, zfar:v.zfar}, snap); return true;
    },
    /* an orbit for pages with no file camera yet */
    orbit(centre, yaw, pitch, dist, yfov=0.6, snap=false){
      const cp=Math.cos(pitch), sp=Math.sin(pitch);
      const eye=[centre[0]+Math.sin(yaw)*cp*dist, centre[1]+sp*dist, centre[2]+Math.cos(yaw)*cp*dist];
      const f=[centre[0]-eye[0],centre[1]-eye[1],centre[2]-eye[2]]; const fl=Math.hypot(...f)||1; f[0]/=fl;f[1]/=fl;f[2]/=fl;
      const upW=[0,1,0];
      const s=[f[1]*upW[2]-f[2]*upW[1], f[2]*upW[0]-f[0]*upW[2], f[0]*upW[1]-f[1]*upW[0]]; const sl=Math.hypot(...s)||1; s[0]/=sl;s[1]/=sl;s[2]/=sl;
      const u=[s[1]*f[2]-s[2]*f[1], s[2]*f[0]-s[0]*f[2], s[0]*f[1]-s[1]*f[0]];
      const Wm=new Float32Array([s[0],s[1],s[2],0, u[0],u[1],u[2],0, -f[0],-f[1],-f[2],0, eye[0],eye[1],eye[2],1]);
      cam.target({world:Wm, yfov, znear:0, zfar:0}, snap);
    },
    /* per-part presence · 1 solid, 0 gone, in between a screen-door ghost. `sel` is a regex on the
       node name or a predicate; a ghosted part also stops casting a shadow (the shadow pass still
       cuts at 0.5), which is what a cutaway wants. */
    ghost(S, sel, presence){
      const test = sel instanceof RegExp ? (n=>sel.test(n.name)) : sel;
      let n=0; for (const node of S.scene.nodes){ if (node.mesh!=null && test(node)){ node.presence=presence; n++; } }
      return n;
    },
    /* per-part tint · rgb + strength, by node name */
    tint(S, nodeName, rgb, a){
      const n=S.scene.byName.get(nodeName); if(!n) return false;
      for (const P of (S.partByNode.get(n.i)||[])){ S.tint.set([rgb[0],rgb[1],rgb[2],a], P.index*4); }
      return true;
    },
    project(pt){
      const m=lastVP; if(!m) return null;
      const cx=m[0]*pt[0]+m[4]*pt[1]+m[8]*pt[2]+m[12], cy=m[1]*pt[0]+m[5]*pt[1]+m[9]*pt[2]+m[13],
            cw=m[3]*pt[0]+m[7]*pt[1]+m[11]*pt[2]+m[15];
      if (cw<=0) return null;
      return [(cx/cw*0.5+0.5)*canvas.clientWidth, (1-(cy/cw*0.5+0.5))*canvas.clientHeight];
    },
    stats(){
      return { fps, cpuMs:+cpuMs.toFixed(2), draws, W, H, ss:SS, errors:errors.slice(),
        nodes:scenes.reduce((a,S)=>a+S.scene.nodes.length,0),
        parts:scenes.reduce((a,S)=>a+S.parts.length,0),
        tris:scenes.reduce((a,S)=>a+S.tris,0),
        scenes:scenes.map(S=>({name:S.name, nodes:S.scene.nodes.length, parts:S.parts.length, tris:S.tris, groups:S.groups.length, blend:S.blendParts.length, tangents:S.tangents})) };
    },
    errors,
    _dbg:{ shadowTex, envL, envD, lightMatrix, get shadowHalf(){ return shadowHalf; }, get shadowCentre(){ return shadowCentre; } },
  };
  return R;
}
