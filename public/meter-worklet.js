// AudioWorklet 全局作用域：每块计算 RMS 与峰值，通过端口回传。
// 纯 JS 文件，放在 public/ 下由浏览器直接加载，不参与主 bundle 打包。
class MeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.last = 0;
  }

  process(inputs, _outputs, params) {
    const input = inputs[0];
    let peak = 0;
    let sumSq = 0;
    let n = 0;
    if (input) {
      for (let ch = 0; ch < input.length; ch++) {
        const d = input[ch];
        for (let i = 0; i < d.length; i++) {
          const v = d[i];
          const a = Math.abs(v);
          if (a > peak) peak = a;
          sumSq += v * v;
          n++;
        }
      }
    }
    const rms = n > 0 ? Math.sqrt(sumSq / n) : 0;
    // 约每 50ms 上报一次（128 采样/块，48k 下 ~375 块/秒）
    const interval = params.interval ? params.interval[0] : 18;
    this.last++;
    if (this.last >= interval) {
      this.last = 0;
      this.port.postMessage({ rms, peak });
    }
    return true;
  }

  static get parameterDescriptors() {
    return [
      {
        name: 'interval',
        defaultValue: 18,
        minValue: 1,
        maxValue: 200,
        automationRate: 'k-rate',
      },
    ];
  }
}

registerProcessor('meter-processor', MeterProcessor);
