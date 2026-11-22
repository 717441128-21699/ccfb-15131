/**
 * Minimal WebGL2 helpers: shader compilation, programs, VAOs, FBOs.
 */

export function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('Failed to allocate shader');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile error: ${log}\n--- source ---\n${src}`);
  }
  return sh;
}

export interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

export function u(prog: Program, name: string): WebGLUniformLocation | null {
  return prog.uniforms[name] ?? null;
}

export function linkProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string,
  uniformNames: string[],
): Program {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link error: ${log}`);
  }
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
  return { program, uniforms };
}

/** Full-screen triangle VAO (covers the viewport with no VBO attributes). */
export function createFullscreenVao(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  return vao;
}

export function createTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  internalFormat: number,
  format: number,
  type: number,
  filter: number,
): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, null);
  return tex;
}

export interface Fbo {
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
}

export function createFbo(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  internalFormat: number = gl.RGBA8,
  format: number = gl.RGBA,
  type: number = gl.UNSIGNED_BYTE,
): Fbo {
  const texture = createTexture(gl, width, height, internalFormat, format, type, gl.LINEAR);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`FBO incomplete: ${status}`);
  return { fbo, texture, width, height };
}

export class GpuTimer {
  private ext: EXT_disjoint_timer_query_webgl2 | null;
  private active: WebGLQuery[] = [];
  private pending: { query: WebGLQuery; resolve: (ms: number) => void }[] = [];

  constructor(private gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }
  get available(): boolean {
    return this.ext !== null;
  }

  begin(): void {
    if (!this.ext) return;
    const q = this.gl.createQuery()!;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active.push(q);
  }

  end(): Promise<number> {
    if (!this.ext || !this.active.length) return Promise.resolve(0);
    const q = this.active.pop()!;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    return new Promise((resolve) => {
      this.pending.push({ query: q, resolve });
    });
  }

  /** Poll finished queries; call once per frame. */
  poll(): void {
    if (!this.ext) return;
    const remaining: typeof this.pending = [];
    for (const item of this.pending) {
      const available = this.gl.getQueryParameter(item.query, this.gl.QUERY_RESULT_AVAILABLE);
      const disjoint = this.gl.getParameter(this.ext!.GPU_DISJOINT_EXT);
      if (available && !disjoint) {
        const ns = this.gl.getQueryParameter(item.query, this.ext!.QUERY_RESULT_EXT);
        item.resolve(Number(ns) / 1e6);
        this.gl.deleteQuery(item.query);
      } else {
        remaining.push(item);
      }
    }
    this.pending = remaining;
  }
}
