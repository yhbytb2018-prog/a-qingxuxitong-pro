import { ThemeDenoiser } from '../src/themes.js';
// 复现 test 5 的数据，打印实际去噪结果
const days = [{
  hot: [
    { code: 'A', reason: '上海国资+半导体' },
    { code: 'B', reason: '广州国资入主+PCB' },
    { code: 'C', reason: '国资+并购重组' },
    { code: 'D', reason: '拟收购界面财联社' },
    { code: 'E', reason: '上海国资+半导体' },
    { code: 'A', reason: '上海国资+半导体' },
  ],
}];
const dn = new ThemeDenoiser().fit(days);
const byDay = dn.themesAllDays(days);
console.log('validThemes:', [...dn.validThemes]);
console.log('byDay[0]:', Object.fromEntries(Object.entries(byDay[0]).map(([k,v])=>[k,[...v]])));
