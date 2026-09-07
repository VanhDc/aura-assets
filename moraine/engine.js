/* ═══════════ MORAINE · GLB scene loader ═══════════
   Kestrel baked every node's matrix into its vertices at load time, which is right for a
   keyboard and wrong for a bike: here the nodes ARE the animation. Wheels spin, the fork
   dives, a hundred and eighteen chain links each carry their own clip, a camera and two
   lights are nodes too. So this loader keeps the graph · parents, TRS, skins, cameras,
   lights · and samples the scene animation per node at whatever time the page asks for.

   Everything is plain typed arrays and column-major Float32Array(16) matrices, no
   dependencies. The renderer (_render.js) reads `scene.nodes[i].world`, the joint
   palettes, the live material/camera/light values, and nothing else. */

/* `clampf`, not `clamp` · the site's files declare their own clamp/lerp and every file lands in ONE module */
const clampf = (v,a,b) => Math.min(b, Math.max(a, v));

/* ── mat4 · column-major, the glTF and WGSL convention ── */
const M4 = {
  ident(){ const m=new Float32Array(16); m[0]=m[5]=m[10]=m[15]=1; return m; },
  mul(a,b,o){                                  /* o = a * b */
    o = o || new Float32Array(16);
    const a00=a[0],a01=a[1],a02=a[2],a03=a[3], a10=a[4],a11=a[5],a12=a[6],a13=a[7],
          a20=a[8],a21=a[9],a22=a[10],a23=a[11], a30=a[12],a31=a[13],a32=a[14],a33=a[15];
    for (let c=0;c<4;c++){
      const b0=b[c*4],b1=b[c*4+1],b2=b[c*4+2],b3=b[c*4+3];
      o[c*4]  =a00*b0+a10*b1+a20*b2+a30*b3;
      o[c*4+1]=a01*b0+a11*b1+a21*b2+a31*b3;
      o[c*4+2]=a02*b0+a12*b1+a22*b2+a32*b3;
      o[c*4+3]=a03*b0+a13*b1+a23*b2+a33*b3;
    }
    return o;
  },
  fromTRS(t,r,s,o){
    o = o || new Float32Array(16);
    const x=r[0],y=r[1],z=r[2],w=r[3];
    const x2=x+x,y2=y+y,z2=z+z, xx=x*x2,xy=x*y2,xz=x*z2,yy=y*y2,yz=y*z2,zz=z*z2,wx=w*x2,wy=w*y2,wz=w*z2;
    o[0]=(1-(yy+zz))*s[0]; o[1]=(xy+wz)*s[0];     o[2]=(xz-wy)*s[0];     o[3]=0;
    o[4]=(xy-wz)*s[1];     o[5]=(1-(xx+zz))*s[1]; o[6]=(yz+wx)*s[1];     o[7]=0;
    o[8]=(xz+wy)*s[2];     o[9]=(yz-wx)*s[2];     o[10]=(1-(xx+yy))*s[2]; o[11]=0;
    o[12]=t[0]; o[13]=t[1]; o[14]=t[2]; o[15]=1;
    return o;
  },
  invert(m,o){                                 /* general inverse · cameras and IBMs are rigid but a scaled parent is not */
    o = o || new Float32Array(16);
    const a00=m[0],a01=m[1],a02=m[2],a03=m[3],a10=m[4],a11=m[5],a12=m[6],a13=m[7],
          a20=m[8],a21=m[9],a22=m[10],a23=m[11],a30=m[12],a31=m[13],a32=m[14],a33=m[15];
    const b00=a00*a11-a01*a10,b01=a00*a12-a02*a10,b02=a00*a13-a03*a10,b03=a01*a12-a02*a11,
          b04=a01*a13-a03*a11,b05=a02*a13-a03*a12,b06=a20*a31-a21*a30,b07=a20*a32-a22*a30,
          b08=a20*a33-a23*a30,b09=a21*a32-a22*a31,b10=a21*a33-a23*a31,b11=a22*a33-a23*a32;
    let det=b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;
    if (!det) return M4.ident();
    det=1/det;
    o[0]=(a11*b11-a12*b10+a13*b09)*det; o[1]=(a02*b10-a01*b11-a03*b09)*det;
    o[2]=(a31*b05-a32*b04+a33*b03)*det; o[3]=(a22*b04-a21*b05-a23*b03)*det;
    o[4]=(a12*b08-a10*b11-a13*b07)*det; o[5]=(a00*b11-a02*b08+a03*b07)*det;
    o[6]=(a32*b02-a30*b05-a33*b01)*det; o[7]=(a20*b05-a22*b02+a23*b01)*det;
    o[8]=(a10*b10-a11*b08+a13*b06)*det; o[9]=(a01*b08-a00*b10-a03*b06)*det;
    o[10]=(a30*b04-a31*b02+a33*b00)*det; o[11]=(a21*b02-a20*b04-a23*b00)*det;
    o[12]=(a11*b07-a10*b09-a12*b06)*det; o[13]=(a00*b09-a01*b07+a02*b06)*det;
    o[14]=(a31*b01-a30*b03-a32*b00)*det; o[15]=(a20*b03-a21*b01+a22*b00)*det;
    return o;
  },
  xformPoint(m,p){ return [m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12], m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13], m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]]; },
  xformDir(m,v){ return [m[0]*v[0]+m[4]*v[1]+m[8]*v[2], m[1]*v[0]+m[5]*v[1]+m[9]*v[2], m[2]*v[0]+m[6]*v[1]+m[10]*v[2]]; },
};

/* ── quaternion · shortest-path slerp, and nlerp when the arc is tiny ── */
function slerp(a, b, t, o){
  let bx=b[0],by=b[1],bz=b[2],bw=b[3];
  let d=a[0]*bx+a[1]*by+a[2]*bz+a[3]*bw;
  if (d<0){ bx=-bx; by=-by; bz=-bz; bw=-bw; d=-d; }
  let ka, kb;
  if (d>0.9995){ ka=1-t; kb=t; }
  else { const th=Math.acos(d), s=Math.sin(th); ka=Math.sin((1-t)*th)/s; kb=Math.sin(t*th)/s; }
  o[0]=a[0]*ka+bx*kb; o[1]=a[1]*ka+by*kb; o[2]=a[2]*ka+bz*kb; o[3]=a[3]*ka+bw*kb;
  const L=Math.hypot(o[0],o[1],o[2],o[3])||1;
  o[0]/=L; o[1]/=L; o[2]/=L; o[3]/=L;
  return o;
}
function quatMul(a,b,o){
  const ax=a[0],ay=a[1],az=a[2],aw=a[3], bx=b[0],by=b[1],bz=b[2],bw=b[3];
  o=o||new Float32Array(4);
  o[0]=aw*bx+ax*bw+ay*bz-az*by; o[1]=aw*by-ax*bz+ay*bw+az*bx;
  o[2]=aw*bz+ax*by-ay*bx+az*bw; o[3]=aw*bw-ax*bx-ay*by-az*bz;
  return o;
}
/* axis-angle · what the page uses to steer (Steer about its local Y) and spin a wheel */
function quatAxis(axis, rad){
  const l=Math.hypot(axis[0],axis[1],axis[2])||1, s=Math.sin(rad/2);
  return new Float32Array([axis[0]/l*s, axis[1]/l*s, axis[2]/l*s, Math.cos(rad/2)]);
}

/* ── the pointer table ──
   KHR_animation_pointer names a JSON path. Only these are meaningful to the renderer;
   anything else is kept in `scene.ignoredPointers` so a missing effect can be diagnosed
   rather than silently dropped. */
const POINTERS = [
  [/^\/nodes\/(\d+)\/(translation|rotation|scale|weights)$/, 'node'],
  [/^\/materials\/(\d+)\/pbrMetallicRoughness\/baseColorFactor$/, 'material', 'base', 4],
  [/^\/materials\/(\d+)\/pbrMetallicRoughness\/roughnessFactor$/, 'material', 'roughness', 1],
  [/^\/materials\/(\d+)\/pbrMetallicRoughness\/metallicFactor$/, 'material', 'metallic', 1],
  [/^\/materials\/(\d+)\/emissiveFactor$/, 'material', 'emissive', 3],
  [/^\/materials\/(\d+)\/extensions\/KHR_materials_emissive_strength\/emissiveStrength$/, 'material', 'emissiveStrength', 1],
  [/^\/materials\/(\d+)\/alphaCutoff$/, 'material', 'alphaCutoff', 1],
  [/^\/materials\/(\d+)\/normalTexture\/scale$/, 'material', 'nrmScale', 1],
  [/^\/materials\/(\d+)\/occlusionTexture\/strength$/, 'material', 'occStrength', 1],
  [/^\/materials\/(\d+)\/extensions\/KHR_materials_clearcoat\/clearcoatFactor$/, 'material', 'clearcoat', 1],
  [/^\/materials\/(\d+)\/extensions\/KHR_materials_clearcoat\/clearcoatRoughnessFactor$/, 'material', 'coatRough', 1],
  [/^\/materials\/(\d+)\/extensions\/KHR_materials_transmission\/transmissionFactor$/, 'material', 'transmission', 1],
  [/^\/cameras\/(\d+)\/perspective\/yfov$/, 'camera', 'yfov', 1],
  [/^\/cameras\/(\d+)\/perspective\/znear$/, 'camera', 'znear', 1],
  [/^\/cameras\/(\d+)\/perspective\/zfar$/, 'camera', 'zfar', 1],
  [/^\/extensions\/KHR_lights_punctual\/lights\/(\d+)\/intensity$/, 'light', 'intensity', 1],
  [/^\/extensions\/KHR_lights_punctual\/lights\/(\d+)\/color$/, 'light', 'color', 3],
  [/^\/extensions\/KHR_lights_punctual\/lights\/(\d+)\/range$/, 'light', 'range', 1],
  [/^\/extensions\/KHR_lights_punctual\/lights\/(\d+)\/spot\/innerConeAngle$/, 'light', 'inner', 1],
  [/^\/extensions\/KHR_lights_punctual\/lights\/(\d+)\/spot\/outerConeAngle$/, 'light', 'outer', 1],
];

export function parseGLB(bytes, name='scene'){
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0,true) !== 0x46546C67) throw new Error('not a GLB');
  const total = dv.getUint32(8,true);
  let off=12, json=null, bin=null;
  while (off < total){
    const len=dv.getUint32(off,true), type=dv.getUint32(off+4,true); off+=8;
    if (type===0x4E4F534A) json=JSON.parse(new TextDecoder().decode(bytes.subarray(off,off+len)));
    else if (type===0x004E4942) bin=bytes.subarray(off,off+len);
    off+=len;
  }
  const COMP={5120:Int8Array,5121:Uint8Array,5122:Int16Array,5123:Uint16Array,5125:Uint32Array,5126:Float32Array};
  const NUM={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16};
  const NORM={5120:1/127,5121:1/255,5122:1/32767,5123:1/65535};
  const acc = ai => {
    const a=json.accessors[ai], TA=COMP[a.componentType], n=NUM[a.type];
    let out;
    if (a.bufferView!=null){
      const bv=json.bufferViews[a.bufferView];
      const start=bin.byteOffset+(bv.byteOffset||0)+(a.byteOffset||0);
      const stride=bv.byteStride||0;
      if (stride && stride!==TA.BYTES_PER_ELEMENT*n){
        /* interleaved · Blender never writes it, other tools do */
        out=new TA(a.count*n);
        for (let i=0;i<a.count;i++){
          const row=new TA(bin.buffer, start+i*stride, n);
          out.set(row, i*n);
        }
      } else out=new TA(bin.buffer, start, a.count*n);
    } else out=new TA(a.count*n);              /* no bufferView · zeros, then sparse */
    /* SPARSE · a shape key that moves 36 of 600 verts stores 36 values and an index list.
       Read dense and you get the base mesh back and a morph that does nothing. */
    if (a.sparse){
      out=new TA(out);                          /* copy · never write into the GLB buffer */
      const sp=a.sparse, ibv=json.bufferViews[sp.indices.bufferView], IT=COMP[sp.indices.componentType];
      const idx=new IT(bin.buffer, bin.byteOffset+(ibv.byteOffset||0)+(sp.indices.byteOffset||0), sp.count);
      const vbv=json.bufferViews[sp.values.bufferView];
      const val=new TA(bin.buffer, bin.byteOffset+(vbv.byteOffset||0)+(sp.values.byteOffset||0), sp.count*n);
      for (let i=0;i<sp.count;i++) for (let c=0;c<n;c++) out[idx[i]*n+c]=val[i*n+c];
    }
    /* normalised integer attributes (weights, colours) → float */
    if (a.normalized && TA!==Float32Array){
      const f=new Float32Array(out.length), k=NORM[a.componentType];
      for (let i=0;i<out.length;i++) f[i]=out[i]*k;
      return f;
    }
    return out;
  };
  const toF32 = (arr) => arr instanceof Float32Array ? arr : Float32Array.from(arr);

  /* ── materials · live factors, the pointer channels write straight into these ── */
  const materials=(json.materials||[]).map((M0,i)=>{
    const m=M0.pbrMetallicRoughness||{};
    const cc=M0.extensions?.KHR_materials_clearcoat, tr=M0.extensions?.KHR_materials_transmission;
    /* KHR_texture_transform · one transform per material (Blender writes the same mapping on every
       slot); the first slot that carries one wins */
    const tt=[m.baseColorTexture, M0.normalTexture, m.metallicRoughnessTexture, M0.occlusionTexture, M0.emissiveTexture]
      .map(t=>t?.extensions?.KHR_texture_transform).find(Boolean) || null;
    return {
      kind:'material', i, name:M0.name||('mat'+i),
      base: Float32Array.from(m.baseColorFactor||[1,1,1,1]),
      metallic: m.metallicFactor ?? 1, roughness: m.roughnessFactor ?? 1,
      emissive: Float32Array.from(M0.emissiveFactor||[0,0,0]),
      emissiveStrength: M0.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1,
      alphaMode: M0.alphaMode||'OPAQUE', alphaCutoff: M0.alphaCutoff ?? 0.5,
      doubleSided: !!M0.doubleSided,
      texIndex: m.baseColorTexture ? m.baseColorTexture.index : -1,
      nrmIndex: M0.normalTexture ? M0.normalTexture.index : -1,
      ormIndex: m.metallicRoughnessTexture ? m.metallicRoughnessTexture.index : -1,
      occIndex: M0.occlusionTexture ? M0.occlusionTexture.index : -1,
      emisIndex: M0.emissiveTexture ? M0.emissiveTexture.index : -1,
      nrmScale: M0.normalTexture?.scale ?? 1, occStrength: M0.occlusionTexture?.strength ?? 1,
      /* KHR_materials_clearcoat · a second glossy lobe over the base (paint, enamel, shrink-wrap);
         both factors are pointer targets. KHR_materials_transmission · glass */
      clearcoat: cc ? (cc.clearcoatFactor ?? 0) : 0, coatRough: cc ? (cc.clearcoatRoughnessFactor ?? 0) : 0,
      coatNrmIndex: cc?.clearcoatNormalTexture ? cc.clearcoatNormalTexture.index : -1,
      transmission: tr ? (tr.transmissionFactor ?? 0) : 0,
      uvOffset: Float32Array.from(tt?.offset||[0,0]), uvScale: Float32Array.from(tt?.scale||[1,1]), uvRot: tt?.rotation ?? 0,
      channels: [],
    };
  });

  /* ── meshes · one prim per material, kept in mesh space (no node matrix baked) ── */
  const meshes=(json.meshes||[]).map((mesh,mi)=>({
    i:mi, name:mesh.name||('mesh'+mi),
    weights: mesh.weights ? Float32Array.from(mesh.weights) : null,
    targetNames: mesh.extras?.targetNames || null,
    prims: mesh.primitives.map(p=>{
      const A=p.attributes;
      const raw=p.indices!=null ? acc(p.indices) : null;
      const pos=toF32(acc(A.POSITION));
      const nv=pos.length/3;
      let idx;
      if (raw) idx = raw instanceof Uint32Array ? raw : new Uint32Array(raw);
      else { idx=new Uint32Array(nv); for (let i=0;i<nv;i++) idx[i]=i; }
      /* bounds in mesh space · the renderer sorts transparent parts by their world centre */
      const mn=[1e9,1e9,1e9], mx=[-1e9,-1e9,-1e9];
      for (let i=0;i<pos.length;i+=3) for (let c=0;c<3;c++){ if(pos[i+c]<mn[c])mn[c]=pos[i+c]; if(pos[i+c]>mx[c])mx[c]=pos[i+c]; }
      return {
        position: pos,
        normal:   A.NORMAL!=null ? toF32(acc(A.NORMAL)) : null,
        uv:       A.TEXCOORD_0!=null ? toF32(acc(A.TEXCOORD_0)) : null,
        /* TANGENT · xyz + handedness in w; the renderer falls back to screen-space derivatives without it */
        tangent:  A.TANGENT!=null ? toF32(acc(A.TANGENT)) : null,
        joints:   A.JOINTS_0!=null ? acc(A.JOINTS_0) : null,   /* u8 or u16 · read as numbers */
        weights:  A.WEIGHTS_0!=null ? toF32(acc(A.WEIGHTS_0)) : null,
        vatId:    A._VATID!=null ? toF32(acc(A._VATID)) : null,
        keyId:    A._KEYID!=null ? toF32(acc(A._KEYID)) : (A._ORDER!=null ? toF32(acc(A._ORDER)) : null),
        /* _GROW · 0..1 draw order along the frame's tubes (hero v3: the frame draws itself) */
        grow:     A._GROW!=null ? toF32(acc(A._GROW)) : null,
        index: idx, material: p.material ?? -1,
        /* morph targets · POSITION deltas, sparse or dense, both come back dense here */
        targets: (p.targets||[]).map(t=>t.POSITION!=null ? toF32(acc(t.POSITION)) : null),
        bmin: mn, bmax: mx, vcount: nv,
      };
    }),
  }));

  /* ── cameras and lights · the file's own, with live yfov/intensity ── */
  const cameras=(json.cameras||[]).map((c,i)=>{
    const p=c.perspective||{};
    return { kind:'camera', i, name:c.name||('cam'+i), yfov:p.yfov ?? 0.6, znear:p.znear ?? 10,
             zfar:p.zfar ?? 0, aspect:p.aspectRatio ?? 0, node:-1, channels:[] };
  });
  const lights=(json.extensions?.KHR_lights_punctual?.lights||[]).map((L,i)=>({
    kind:'light', i, name:L.name||('light'+i), type:L.type,
    color: Float32Array.from(L.color||[1,1,1]), intensity: L.intensity ?? 1, range: L.range ?? 0,
    inner: L.spot?.innerConeAngle ?? 0, outer: L.spot?.outerConeAngle ?? Math.PI/4,
    node:-1, channels:[],
  }));

  /* ── nodes · the graph itself ── */
  const nodes=(json.nodes||[]).map((n,i)=>{
    const node={
      kind:'node', i, name:n.name||('node'+i), parent:-1, children:n.children||[],
      t: Float32Array.from(n.translation||[0,0,0]),
      r: Float32Array.from(n.rotation||[0,0,0,1]),
      s: Float32Array.from(n.scale||[1,1,1]),
      matrix: n.matrix ? Float32Array.from(n.matrix) : null,
      mesh: n.mesh ?? -1, skin: n.skin ?? -1, camera: n.camera ?? -1,
      light: n.extensions?.KHR_lights_punctual?.light ?? -1,
      weights: null, local: new Float32Array(16), world: M4.ident(),
      dirty: true, channels: [],
      /* page-side overrides that survive sampling: a rest-scale multiplier (the 40 mm tyre) and
         a rotation applied AFTER the rest rotation, in the node's own frame (steering about the
         local Y that Blender lined up with the head tube) */
      scaleMul: null, rotPost: null, glb: name,
    };
    if (node.mesh>=0){
      const nt=meshes[node.mesh].prims[0]?.targets.length||0;
      if (nt) node.weights = n.weights ? Float32Array.from(n.weights)
                                       : (meshes[node.mesh].weights ? Float32Array.from(meshes[node.mesh].weights) : new Float32Array(nt));
    }
    if (node.camera>=0 && cameras[node.camera]) cameras[node.camera].node=i;
    if (node.light>=0 && lights[node.light]) lights[node.light].node=i;
    return node;
  });
  nodes.forEach(n=>n.children.forEach(c=>{ nodes[c].parent=n.i; }));
  const sceneDef=json.scenes ? json.scenes[json.scene||0] : null;
  const roots=sceneDef ? sceneDef.nodes.slice() : nodes.filter(n=>n.parent<0).map(n=>n.i);

  /* ── skins · joint list and inverse bind matrices ── */
  const skins=(json.skins||[]).map((s,i)=>({
    i, name:s.name||('skin'+i), joints:s.joints.slice(), skeleton:s.skeleton ?? -1,
    ibm: s.inverseBindMatrices!=null ? toF32(acc(s.inverseBindMatrices))
                                     : (()=>{ const o=new Float32Array(16*s.joints.length); for(let j=0;j<s.joints.length;j++) o.set(M4.ident(),j*16); return o; })(),
  }));

  /* ── animation · every channel of every animation merged onto one scene clock ──
     Blender's SCENE export writes one animation per animated datablock, all sharing the
     scene's frame numbers, so time = frame / fps everywhere and the channels can be pooled.
     A channel points at the LIVE object it drives and writes into it when sampled. */
  const channels=[], ignoredPointers=[], animations=[];
  let tmin=1e9, tmax=-1e9;
  (json.animations||[]).forEach((an,ai)=>{
    let amax=0;
    an.channels.forEach(ch=>{
      const sm=an.samplers[ch.sampler];
      const times=toF32(acc(sm.input)), vals=toF32(acc(sm.output));
      const interp=sm.interpolation||'LINEAR';
      let target=null, path=null, comps=0;
      if (ch.target.path==='pointer'){
        const ptr=ch.target.extensions?.KHR_animation_pointer?.pointer||'';
        for (const [re,kind,prop,nc] of POINTERS){
          const m=re.exec(ptr); if(!m) continue;
          const idx=+m[1];
          if (kind==='node'){ target=nodes[idx]; path=m[2]; }
          else { target=({material:materials,camera:cameras,light:lights})[kind][idx]; path=prop; comps=nc; }
          break;
        }
        if (!target){ ignoredPointers.push(ptr); return; }
      } else {
        target=nodes[ch.target.node]; path=ch.target.path;
      }
      if (!target) return;
      if (target.kind==='node'){
        comps = path==='rotation' ? 4 : path==='weights' ? (target.weights ? target.weights.length : 0) : 3;
        if (!comps) return;
      }
      /* CUBICSPLINE stores in-tangent, value, out-tangent per key · we read the value
         and interpolate linearly, which is what a 30 fps forced-sample export is anyway */
      const stride = interp==='CUBICSPLINE' ? comps*3 : comps;
      const c={ target, path, times, vals, comps, stride, off: interp==='CUBICSPLINE' ? comps : 0,
                interp, anim:ai, hint:0, t0:times[0], t1:times[times.length-1] };
      channels.push(c); target.channels.push(c);
      if (c.t0<tmin) tmin=c.t0; if (c.t1>tmax) tmax=c.t1; if (c.t1>amax) amax=c.t1;
    });
    animations.push({ i:ai, name:an.name||('anim'+ai), duration:amax });
  });
  if (tmin>tmax){ tmin=0; tmax=0; }

  /* embedded images come out of a bufferView, not a URI */
  const images=(json.images||[]).map(im=>{
    const bv=json.bufferViews[im.bufferView];
    return new Blob([bin.subarray(bv.byteOffset||0,(bv.byteOffset||0)+bv.byteLength)],{type:im.mimeType||'image/png'});
  });
  /* EXT_texture_webp moves the image index · `texture.source` is UNDEFINED on a webp file */
  const texImage = ti => {
    if (ti==null || ti<0) return null;
    const t=json.textures[ti];
    const src=t.source ?? t.extensions?.EXT_texture_webp?.source ?? t.extensions?.KHR_texture_basisu?.source;
    return src==null ? null : images[src];
  };

  /* the glTF sampler of a texture · wrap modes matter (the gravel and the tread tile with REPEAT) */
  const WRAP={10497:'repeat', 33071:'clamp-to-edge', 33648:'mirror-repeat'};
  const texSampler = ti => {
    const t = (ti==null || ti<0) ? null : json.textures[ti];
    const s = (t && t.sampler!=null) ? json.samplers[t.sampler] : null;
    return { wrapU: WRAP[s?.wrapS] || 'repeat', wrapT: WRAP[s?.wrapT] || 'repeat' };
  };
  const scene={ kind:'scene', name, json, nodes, roots, meshes, materials, cameras, lights, skins,
                channels, animations, ignoredPointers, timeRange:[tmin,tmax], texImage, texSampler,
                byName: new Map(nodes.map(n=>[n.name,n])) };
  attachMethods(scene);
  scene.updateWorld();
  return scene;
}

/* ── sampling ── */
function findKey(times, t, hint){
  const n=times.length;
  if (t<=times[0]) return 0;
  if (t>=times[n-1]) return n-1;
  /* scrubbing is usually monotone · try the neighbourhood of the last answer first */
  let lo=0, hi=n-1;
  if (hint<n-1 && times[hint]<=t){ if (t<times[hint+1]) return hint; lo=hint; }
  while (hi-lo>1){ const mid=(lo+hi)>>1; if (times[mid]<=t) lo=mid; else hi=mid; }
  return lo;
}
const TMP4=new Float32Array(4), TMPB=new Float32Array(4), TMPQ=new Float32Array(4), TMPS=new Float32Array(3);
function sampleChannel(c, t, out){
  const {times, vals, comps, stride, off}=c;
  const n=times.length;
  const k=findKey(times, t, c.hint); c.hint=k;
  const a=k*stride+off;
  if (k>=n-1 || c.interp==='STEP' || t<=times[0]){
    for (let i=0;i<comps;i++) out[i]=vals[a+i];
    return out;
  }
  const b=(k+1)*stride+off;
  const u=clampf((t-times[k])/(times[k+1]-times[k]||1e-6), 0, 1);
  if (c.path==='rotation'){
    for (let i=0;i<4;i++){ TMP4[i]=vals[a+i]; TMPB[i]=vals[b+i]; }
    return slerp(TMP4, TMPB, u, out);
  }
  for (let i=0;i<comps;i++) out[i]=vals[a+i]+(vals[b+i]-vals[a+i])*u;
  return out;
}
function writeTarget(c, out){
  const T=c.target;
  if (T.kind==='node'){
    if (c.path==='translation') T.t.set(out.subarray ? out.subarray(0,3) : out);
    else if (c.path==='rotation') T.r.set(out.subarray ? out.subarray(0,4) : out);
    else if (c.path==='scale') T.s.set(out.subarray ? out.subarray(0,3) : out);
    else if (c.path==='weights') T.weights.set(out.subarray ? out.subarray(0,c.comps) : out);
    T.dirty=true;
    return;
  }
  /* material · camera · light: scalars land as numbers, vectors into their arrays */
  if (c.comps===1) T[c.path]=out[0];
  else T[c.path].set(out.subarray ? out.subarray(0,c.comps) : out);
  T.dirty=true;
}

function attachMethods(S){
  const scratch=new Float32Array(64);
  /* every channel that drives this object, at time t (seconds on the scene clock) */
  S.sampleTarget = (T, t) => {
    for (const c of T.channels) writeTarget(c, sampleChannel(c, t, scratch));
    return T;
  };
  S.sampleNode = (nodeIndex, t) => S.sampleTarget(typeof nodeIndex==='number' ? S.nodes[nodeIndex] : S.byName.get(nodeIndex), t);
  /* timeFn(target) → seconds, or null/undefined to leave that target alone. It is called
     for nodes AND for materials, cameras and lights (each carries `.kind` and `.name`), so
     one function can give the drivetrain its `run` time while the paint holds its own. */
  S.sampleAll = (timeFn) => {
    let n=0;
    const one=(T)=>{ if(!T.channels.length) return; const t=timeFn(T); if (t==null||t!==t) return; S.sampleTarget(T,t); n++; };
    S.nodes.forEach(one); S.materials.forEach(one); S.cameras.forEach(one); S.lights.forEach(one);
    return n;
  };
  S.sampleRange = (frames, t01, fps=30, filter=null) => {
    const t=(frames[0]+(frames[1]-frames[0])*clampf(t01,0,1))/fps;
    return S.sampleAll(T => (!filter || filter(T)) ? t : null);
  };
  /* rest = the scene at its first key (frame 0 by the CONTRACT) */
  S.rest = () => S.sampleAll(()=>S.timeRange[0]);

  /* ── world matrices · a dirty node re-derives its subtree, an untouched one costs nothing ── */
  const walk=(i, parentWorld, parentDirty)=>{
    const n=S.nodes[i];
    const d = n.dirty || parentDirty;
    if (d){
      if (n.matrix && !n.dirty) n.local.set(n.matrix);
      else {
        let r=n.r, sc=n.s;
        if (n.rotPost){ r=quatMul(n.r, n.rotPost, TMPQ); }
        if (n.scaleMul){ TMPS[0]=n.s[0]*n.scaleMul[0]; TMPS[1]=n.s[1]*n.scaleMul[1]; TMPS[2]=n.s[2]*n.scaleMul[2]; sc=TMPS; }
        M4.fromTRS(n.t,r,sc,n.local);
      }
      if (parentWorld) M4.mul(parentWorld, n.local, n.world); else n.world.set(n.local);
      n.dirty=false; n.worldStamp=S.stamp;
    }
    for (const c of n.children) walk(c, n.world, d);
  };
  S.stamp=0;
  /* A scene may RIDE another scene's node. drivetrain.glb is its own file with its own root, and
     bike.glb's `arrive` clip moves BikeRoot six metres · nothing moved DriveRoot, so on the hero the
     drivetrain sat at the destination while the bike drove up to it, and the camera panned onto a
     loose crank, chain and cassette waiting on the ground (owner review 2026-09-05, caught by a
     wall-clock ladder · a scroll ladder cannot see it). `parentWorld` is premultiplied onto every
     root; the caller points it at the carrying node's world matrix and the whole scene follows,
     including the tail's 60 mm step-out, with no per-node keying to keep in sync across files. */
  S.parentWorld = null; S._pwSeen = null;
  S.updateWorld = () => {
    S.stamp++;
    const pw = S.parentWorld;
    const moved = pw && (S._pwSeen === null || pw.some((v,i)=>v!==S._pwSeen[i]));
    if (moved){ S._pwSeen = Float32Array.from(pw); }
    for (const r of S.roots) walk(r, pw || null, !!moved);
    return S.stamp;
  };

  /* joint palette for a skin · world(joint) * inverseBind, written at `off` floats into `out`.
     The skinned mesh's own node transform is ignored, as the spec says; the joints carry it. */
  S.jointMatrices = (skinIndex, out, off=0) => {
    const sk=S.skins[skinIndex];
    for (let j=0;j<sk.joints.length;j++){
      const m=M4.mul(S.nodes[sk.joints[j]].world, sk.ibm.subarray(j*16,j*16+16));
      out.set(m, off+j*16);
    }
    return out;
  };

  /* the camera as the renderer wants it · world matrix (glTF cameras look down local -Z) */
  S.cameraView = (nameOrIndex) => {
    const cam = typeof nameOrIndex==='number' ? S.cameras[nameOrIndex]
              : (S.cameras.find(c=>c.name===nameOrIndex) || S.cameras.find(c=>S.nodes[c.node]?.name===nameOrIndex));
    if (!cam || cam.node<0) return null;
    const W=S.nodes[cam.node].world;
    return { name:cam.name, world:Float32Array.from(W), eye:[W[12],W[13],W[14]],
             right:[W[0],W[1],W[2]], up:[W[4],W[5],W[6]], fwd:[-W[8],-W[9],-W[10]],
             yfov:cam.yfov, znear:cam.znear, zfar:cam.zfar };
  };
  /* lights in world space · glTF lights point down their node's local -Z */
  S.lightState = (name) => {
    const L=S.lights.find(l=>l.name===name);
    if (!L) return null;
    const W=L.node>=0 ? S.nodes[L.node].world : M4.ident();
    const dir=[-W[8],-W[9],-W[10]]; const l=Math.hypot(...dir)||1;
    return { name:L.name, type:L.type, pos:[W[12],W[13],W[14]], dir:[dir[0]/l,dir[1]/l,dir[2]/l],
             color:L.color, intensity:L.intensity, range:L.range, inner:L.inner, outer:L.outer };
  };

  /* world-space bounds of everything with a mesh, at the CURRENT pose */
  S.bounds = () => {
    const mn=[1e9,1e9,1e9], mx=[-1e9,-1e9,-1e9];
    for (const n of S.nodes){
      if (n.mesh<0) continue;
      for (const p of S.meshes[n.mesh].prims){
        for (let k=0;k<8;k++){
          const c=[(k&1)?p.bmax[0]:p.bmin[0], (k&2)?p.bmax[1]:p.bmin[1], (k&4)?p.bmax[2]:p.bmin[2]];
          const w=M4.xformPoint(n.world, c);
          for (let i=0;i<3;i++){ if(w[i]<mn[i])mn[i]=w[i]; if(w[i]>mx[i])mx[i]=w[i]; }
        }
      }
    }
    return { min:mn, max:mx, centre:[(mn[0]+mx[0])/2,(mn[1]+mx[1])/2,(mn[2]+mx[2])/2],
             radius: Math.hypot(mx[0]-mn[0],mx[1]-mn[1],mx[2]-mn[2])/2 };
  };
  S.node = (name) => S.byName.get(name) || null;
  S.findNodes = (re) => S.nodes.filter(n=>re.test(n.name));
  /* pose a node by hand · the page steers `Steer` and spins a wheel this way */
  S.setRotation = (name, q) => { const n=S.byName.get(name); if(!n) return false; n.r.set(q); n.dirty=true; return true; };
  S.setTranslation = (name, t) => { const n=S.byName.get(name); if(!n) return false; n.t.set(t); n.dirty=true; return true; };
  S.setScale = (name, s) => { const n=S.byName.get(name); if(!n) return false; n.s.set(s); n.dirty=true; return true; };
  /* morph by target NAME (Blender writes mesh.extras.targetNames) or by index */
  /* morph by NODE name with a {targetName: weight} map · what the page calls */
  S.setMorphs = (nodeName, weights) => {
    const n=S.byName.get(nodeName); if(!n || n.mesh<0 || !n.weights) return false;
    const names=S.meshes[n.mesh].targetNames||[];
    let hit=0;
    for (const [k,w] of Object.entries(weights)){ const ti=names.indexOf(k); if (ti>=0 && ti<n.weights.length){ n.weights[ti]=w; hit++; } }
    if (hit) n.dirty=true;
    return hit>0;
  };
  S.setMorph = (target, w) => {
    let hit=0;
    for (const n of S.nodes){
      if (n.mesh<0 || !n.weights) continue;
      const names=S.meshes[n.mesh].targetNames||[];
      const ti = typeof target==='number' ? target : names.indexOf(target);
      if (ti<0 || ti>=n.weights.length) continue;
      n.weights[ti]=w; n.dirty=true; hit++;
    }
    return hit;
  };
  S.stats = () => ({
    nodes:S.nodes.length, meshes:S.meshes.length, skins:S.skins.length, cameras:S.cameras.length,
    lights:S.lights.length, channels:S.channels.length, animations:S.animations.length,
    ignoredPointers:S.ignoredPointers.length,
    tris: S.nodes.reduce((a,n)=> n.mesh<0 ? a : a + S.meshes[n.mesh].prims.reduce((b,p)=>b+p.index.length/3,0), 0),
  });
}

export { M4, slerp, quatMul, quatAxis, clampf };
