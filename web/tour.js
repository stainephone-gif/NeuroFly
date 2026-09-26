// A short guided tour: what a connection is, and how one new connection
// changes what the fly does. Each step explains, then asks the visitor to
// press one action, then shows what happened. The tour only uses the same
// commands a visitor has: scenarios and Connect.

export const TOUR = [
  {
    title: 'Мозг мухи',
    text: 'Перед вами все 139 тысяч нейронов мозга дрозофилы и 54 миллиона связей между ними. Это цифровая копия настоящего мозга. Справа муха, которой этот мозг управляет.',
    focus: null,
  },
  {
    title: 'Вкус',
    text: 'На передних лапках мухи сидят нейроны вкуса. Двадцать один из них чувствует сахар. Дайте мухе сахар и посмотрите, что произойдёт.',
    focus: 'sugar', lines: 'sugar',
    action: { label: 'Дать сахар', run: (t) => t.scenario('sugar', true) },
    after: 'Сигнал от лапки прошёл через несколько сотен нейронов и дошёл до мотонейрона хоботка. Муха вытянула хоботок: так она пробует еду. Идти она не стала.',
  },
  {
    title: 'Команда «вперёд»',
    text: 'В мозге есть два нейрона DNp09. Они спускаются к ногам и командуют: идти. Включите их.',
    focus: 'p9', lines: 'p9',
    before: (t) => t.scenario('sugar', false),
    action: { label: 'Идти вперёд', run: (t) => t.scenario('p9', true) },
    after: 'Муха пошла. Обратите внимание: сахар при этом не участвует. Вкус и ходьба в этом мозге не соединены напрямую.',
  },
  {
    title: 'Связь, которой нет',
    text: 'Теперь соединим нейроны вкуса с нейронами ходьбы. В настоящем мозге такой связи нет. Проведите её.',
    focus: 'p9', lines: null,
    before: (t) => t.scenario('p9', false),
    action: { label: 'Связать вкус → DNp09', run: (t) => t.connect('sugar', 'p9') },
    after: 'Связь появилась: каждый из 21 нейрона вкуса теперь соединён с обоими DNp09, жёлтые линии в мозге. Пока ничего не изменилось, потому что сахара нет.',
  },
  {
    title: 'Тот же сахар, другая муха',
    text: 'Дайте мухе сахар ещё раз. Сахар тот же, мозг почти тот же, но одна связь новая.',
    focus: 'sugar', lines: null,
    action: { label: 'Дать сахар', run: (t) => t.scenario('sugar', true) },
    after: 'Теперь муха идёт на сахар. Одна новая связь превратила «попробовать» в «пойти». Так и устроена память: не новые нейроны, а новые связи между старыми.',
  },
  {
    title: 'Наоборот',
    text: 'Поменяем связь: вместо «вперёд» соединим вкус с нейронами заднего хода MDN.',
    focus: 'MDN', lines: null,
    before: (t) => { t.scenario('sugar', false); t.disconnectAll(); },
    action: { label: 'Связать вкус → MDN и дать сахар', run: (t) => { t.connect('sugar', 'MDN'); setTimeout(() => t.scenario('sugar', true), 600); } },
    after: 'Та же муха, тот же сахар, но теперь она пятится от него. Поведение живёт не в нейронах, а в том, кто с кем соединён.',
  },
  {
    title: 'Ваша очередь',
    text: 'Уберём вашу связь: муха снова только пробует сахар. Дальше пробуйте сами: режим «Связать», щелчок по источнику, щелчок по цели, потом любой сценарий.',
    focus: null, lines: null,
    before: (t) => { t.scenario('sugar', false); t.disconnectAll(); },
    last: true,
  },
];
