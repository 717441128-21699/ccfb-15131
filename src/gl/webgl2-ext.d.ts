/**
 * Ambient WebGL2 extension types not present in the standard TS DOM lib.
 */

interface EXT_disjoint_timer_query_webgl2 {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
  readonly QUERY_RESULT_EXT: number;
}

interface WebGL2RenderingContext {
  getExtension(name: 'EXT_disjoint_timer_query_webgl2'): EXT_disjoint_timer_query_webgl2 | null;
}
