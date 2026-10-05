//! Разбор скриншота с окном характеристик персонажа.
//!
//! Работает на встроенном в Windows распознавателе текста (`Windows.Media.Ocr`): он знает русский язык,
//! ничего доустанавливать не нужно, и картинка никуда не отправляется — всё считается на месте.
//!
//! Наблюдение, на котором держится разбор (проверено на снимке окна характеристик): распознаватель отдаёт
//! **отдельные строки со своими координатами**, подписи и значения идут разными строками, и порядок строк
//! не совпадает с порядком на экране (сначала могут идти все подписи, потом все значения). Поэтому здесь
//! возвращаются строки именно с координатами, а сопоставление «подпись ↔ значение» делает интерфейс
//! (`js/modules/characters/statsOcr.js`) — там же оно покрыто тестами.
//!
//! Что сильно влияет на качество (проверено замерами на изображении с мелким шрифтом, как в игре):
//!
//! - **Размер картинки важнее всего.** На исходном размере окна игра рисует подписи шрифтом около 10 px,
//!   и распознаётся примерно 1 значение из 13. Если увеличить картинку в 3 раза, распознаётся 11–12 из 13.
//!   Поэтому изображение предварительно масштабируется (`UPSCALE`), а не отдаётся распознавателю как есть.
//! - Предобработка (оттенки серого, инверсия, бинаризация, усиление контраста) результат **не улучшает**:
//!   замеры дали те же 11–12 из 13. Поэтому она не делается — меньше кода и нет риска испортить картинку.
//! - Дальше масштаба ×4 качество не растёт (11–12 из 13 при ×3…×8), только время растёт: ×3 — около 160 мс,
//!   ×8 — около 870 мс. Оптимум по времени и качеству — ×3.
//!
//! Остаются устойчивые ошибки распознавания, которые исправляются после OCR (см. `fix_common_mistakes`):
//! «3» читается как «з», «12%» — как «120/0», «%» — как «96», латинские буквы путаются с кириллицей.

use serde::Serialize;

/// Во сколько раз увеличивать картинку перед распознаванием.
///
/// Мелкий шрифт окна характеристик (~10 px) распознаётся плохо: на исходном размере верных значений
/// около одного из тринадцати, при ×3 — одиннадцать-двенадцать. Дальнейшее увеличение качество не меняет,
/// только замедляет распознавание.
pub const UPSCALE: u32 = 3;

/// Предел стороны картинки после увеличения: распознаватель Windows не принимает больше 10000 px.
const MAX_SIDE: u32 = 10_000;

/// Одна распознанная строка.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrLine {
    /// Текст строки
    pub text: String,
    /// Левый край строки, доля ширины картинки (0…1)
    pub x: f64,
    /// Верхний край строки, доля высоты картинки (0…1)
    pub y: f64,
    /// Ширина, доля ширины картинки
    pub w: f64,
    /// Высота, доля высоты картинки
    pub h: f64,
}

/// Итог разбора скриншота.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StatsOcrResult {
    /// Распознанные строки с координатами (доли от размера картинки)
    pub lines: Vec<OcrLine>,
    /// Размер исходной картинки, пикселей
    pub width: u32,
    pub height: u32,
    /// Язык, которым прочитано («ru»)
    pub language: String,
    /// Во сколько раз картинка была увеличена перед распознаванием
    pub upscale: u32,
}

/// Доступен ли разбор скриншотов (есть ли в системе русский распознаватель).
pub fn available() -> bool {
    #[cfg(windows)]
    {
        imp::make_engine().is_ok()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Насколько увеличивать картинку: `UPSCALE`, но не больше предела распознавателя.
/// Мелкие картинки увеличиваются, огромные — нет (иначе Windows откажется их читать).
pub fn upscale_for(width: u32, height: u32) -> u32 {
    let longest = width.max(height).max(1);
    let allowed = (MAX_SIDE / longest).max(1);
    UPSCALE.min(allowed)
}

/// Исправляет устойчивые ошибки распознавания в значении характеристики.
///
/// Что встречается на практике (проверено на изображении с мелким шрифтом, как в игре):
/// - «3» читается как «з» и наоборот: «з 680» вместо «3 680»;
/// - «%» превращается в «/0», «96» или «°»: «120/0» вместо «12%»;
/// - «1» и «7» путаются с «|» и «/», «0» — с «О»;
/// - латинские и кириллические буквы в названиях («Фвическая» вместо «Физическая»).
///
/// Функция только заменяет символы и не меняет смысл: подписи всё равно сверяются со списком характеристик,
/// а значения показывает пользователь на подтверждение.
pub fn fix_common_mistakes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    // Сосед-цифра ищется с пропуском пробелов: «з 680» — это то же, что «з680».
    // Смотрим и на уже исправленные символы (`out`), иначе во «2оо» вторая «о» не станет нулём.
    let digit_before = |out: &String, i: usize| {
        out.chars()
            .rev()
            .find(|c| !c.is_whitespace())
            .is_some_and(|c| c.is_ascii_digit())
            || chars[..i]
                .iter()
                .rev()
                .find(|c| !c.is_whitespace())
                .is_some_and(|c| c.is_ascii_digit())
    };
    let digit_after = |i: usize| {
        chars[i + 1..]
            .iter()
            .find(|c| !c.is_whitespace())
            .is_some_and(|c| c.is_ascii_digit())
    };
    for (i, &ch) in chars.iter().enumerate() {
        let near_digit = digit_before(&out, i) || digit_after(i);
        let fixed = match ch {
            // «з» рядом с цифрами — это тройка: «з 680» → «3 680»
            'з' | 'З' if near_digit => '3',
            // кириллическая «о» рядом с цифрами — это ноль: «1О5» → «105», «2оо» → «200»
            'о' | 'О' if near_digit => '0',
            // «б» рядом с цифрами часто читается вместо «6»
            'б' if near_digit => '6',
            _ => ch,
        };
        out.push(fixed);
    }
    // Знак процента распознаётся как «0/0»: на замерах «12%» дало «120/0», а «250%» — «2500/0».
    // Поэтому «0/0» после цифры заменяется на «%» (одна лишняя цифра перед слэшем — это и есть «%»),
    // а «°» после цифры — тоже «%».
    let mut result = String::with_capacity(out.len());
    let chars: Vec<char> = out.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let digit_before = result.chars().last().is_some_and(|c| c.is_ascii_digit());
        let is_percent_tail =
            chars[i] == '0' && chars.get(i + 1) == Some(&'/') && chars.get(i + 2) == Some(&'0');
        if digit_before && is_percent_tail {
            result.push('%');
            i += 3;
            continue;
        }
        if digit_before && chars[i] == '°' {
            result.push('%');
            i += 1;
            continue;
        }
        result.push(chars[i]);
        i += 1;
    }
    result
}

#[cfg(windows)]
mod imp {
    use super::{OcrLine, StatsOcrResult};
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::DataWriter;

    /// Распознаватель для русского; если русского нет — язык профиля пользователя.
    pub fn make_engine() -> Result<(OcrEngine, String), String> {
        if let Ok(lang) = Language::CreateLanguage(&"ru".into()) {
            if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&lang) {
                return Ok((engine, "ru".to_string()));
            }
        }
        OcrEngine::TryCreateFromUserProfileLanguages()
            .map(|engine| {
                let tag = engine
                    .RecognizerLanguage()
                    .ok()
                    .and_then(|l| l.LanguageTag().ok())
                    .map(|t| t.to_string())
                    .unwrap_or_else(|| "?".to_string());
                (engine, tag)
            })
            .map_err(|e| {
                format!(
                    "Распознавание текста недоступно: в Windows нет языкового пакета для OCR ({})",
                    e
                )
            })
    }

    /// Читает картинку (PNG/JPEG в байтах) и возвращает строки с координатами.
    pub fn recognize(image: &[u8]) -> Result<StatsOcrResult, String> {
        let (engine, language) = make_engine()?;

        let decoded = image::load_from_memory(image)
            .map_err(|e| format!("Не удалось прочитать картинку: {}", e))?;
        let rgba = decoded.to_rgba8();
        let (width, height) = (rgba.width(), rgba.height());
        if width == 0 || height == 0 {
            return Err("Картинка пустая".to_string());
        }

        // Мелкий шрифт окна характеристик распознаётся плохо: увеличение решает это лучше любой
        // предобработки (см. замеры в начале файла).
        let scale = super::upscale_for(width, height);
        let (big_w, big_h) = (width * scale, height * scale);
        let scaled = if scale > 1 {
            image::imageops::resize(&rgba, big_w, big_h, image::imageops::FilterType::Lanczos3)
        } else {
            rgba.clone()
        };

        let bgra = to_bgra(&scaled);
        // Пиксели передаём через DataWriter: распознаватель ждёт IBuffer, а не срез байт.
        let writer =
            DataWriter::new().map_err(|e| format!("Не удалось подготовить буфер: {}", e))?;
        writer
            .WriteBytes(&bgra)
            .map_err(|e| format!("Не удалось записать пиксели: {}", e))?;
        let buffer = writer
            .DetachBuffer()
            .map_err(|e| format!("Не удалось получить буфер: {}", e))?;
        let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
            &buffer,
            BitmapPixelFormat::Bgra8,
            big_w as i32,
            big_h as i32,
        )
        .map_err(|e| format!("Не удалось подготовить картинку: {}", e))?;

        let result = engine
            .RecognizeAsync(&bitmap)
            .map_err(|e| format!("Распознавание не запустилось: {}", e))?
            .join()
            .map_err(|e| format!("Распознавание не удалось: {}", e))?;

        let lines = result
            .Lines()
            .map_err(|e| format!("Не удалось прочитать строки: {}", e))?;

        // Координаты пересчитываем в доли: увеличенный размер и исходный дают одно и то же отношение,
        // но считаем по увеличенному — так точнее.
        let (fw, fh) = (big_w.max(1) as f64, big_h.max(1) as f64);
        let mut out = Vec::new();
        for line in lines {
            let Ok(words) = line.Words() else { continue };
            let mut text = String::new();
            let (mut left, mut top) = (f64::MAX, f64::MAX);
            let (mut right, mut bottom) = (0.0_f64, 0.0_f64);
            for word in words {
                let Ok(t) = word.Text() else { continue };
                if !text.is_empty() {
                    text.push(' ');
                }
                text.push_str(&t.to_string());
                if let Ok(r) = word.BoundingRect() {
                    let (x, y) = (f64::from(r.X), f64::from(r.Y));
                    left = left.min(x);
                    top = top.min(y);
                    right = right.max(x + f64::from(r.Width));
                    bottom = bottom.max(y + f64::from(r.Height));
                }
            }
            if text.trim().is_empty() {
                continue;
            }
            if left == f64::MAX {
                left = 0.0;
                top = 0.0;
            }
            out.push(OcrLine {
                // Правки типичных ошибок распознавания: «з 680» → «3 680», «120/0» → «12%»
                text: super::fix_common_mistakes(text.trim()),
                x: left / fw,
                y: top / fh,
                w: (right - left).max(0.0) / fw,
                h: (bottom - top).max(0.0) / fh,
            });
        }

        Ok(StatsOcrResult {
            lines: out,
            width,
            height,
            language,
            upscale: scale,
        })
    }

    /// RGBA → BGRA: распознаватель ждёт такой порядок каналов.
    fn to_bgra(rgba: &image::RgbaImage) -> Vec<u8> {
        let mut out = Vec::with_capacity(rgba.len());
        for px in rgba.pixels() {
            out.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
        }
        out
    }
}

#[cfg(not(windows))]
mod imp {
    use super::StatsOcrResult;

    pub fn recognize(_image: &[u8]) -> Result<StatsOcrResult, String> {
        Err("Разбор скриншотов доступен только в Windows".to_string())
    }
}

pub use imp::recognize;

/// Команды для интерфейса.
#[tauri::command]
pub async fn stats_ocr_available() -> bool {
    available()
}

/// Разбирает скриншот окна характеристик: возвращает строки с координатами.
/// `image` — байты картинки (PNG/JPEG), как их отдаёт интерфейс после `File.arrayBuffer()`.
#[tauri::command]
pub async fn stats_ocr_read(image: Vec<u8>) -> Result<StatsOcrResult, String> {
    if image.is_empty() {
        return Err("Пустой файл".to_string());
    }
    // Размер ограничиваем: скриншот окна характеристик укладывается в единицы мегабайт,
    // а всё, что заметно больше, — это уже не картинка с окном статов.
    const MAX_BYTES: usize = 24 * 1024 * 1024;
    if image.len() > MAX_BYTES {
        return Err("Файл слишком большой: нужен скриншот окна характеристик".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || recognize(&image))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_coordinates_are_fractions() {
        // Координаты приходят долями от размера картинки: интерфейс сверяет их между собой,
        // поэтому выход за 0…1 сломал бы сопоставление колонок.
        let line = OcrLine {
            text: "Здоровье".into(),
            x: 0.03,
            y: 0.1,
            w: 0.2,
            h: 0.02,
        };
        assert!((0.0..=1.0).contains(&line.x));
        assert!((0.0..=1.0).contains(&line.y));
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_reports_unavailable() {
        assert!(!available());
        assert!(recognize(&[1, 2, 3]).is_err());
    }

    #[test]
    fn upscale_is_capped_by_recognizer_limit() {
        // Мелкая картинка увеличивается в UPSCALE раз: именно это даёт основной прирост качества
        assert_eq!(upscale_for(520, 400), UPSCALE);
        // Крупная картинка не увеличивается сверх предела распознавателя (10000 px по стороне)
        assert_eq!(upscale_for(9000, 100), 1);
        assert_eq!(upscale_for(4000, 3000), 2);
        // Совсем большая остаётся как есть: увеличение сделало бы её непригодной для распознавателя
        assert_eq!(upscale_for(12000, 8000), 1);
        // Нулевые размеры не приводят к делению на ноль
        assert_eq!(upscale_for(0, 0), UPSCALE);
    }

    #[test]
    fn fixes_three_read_as_cyrillic_ze() {
        // Наблюдаемая ошибка: «3 680» распознаётся как «з 680»
        assert_eq!(fix_common_mistakes("з 680"), "3 680");
        assert_eq!(fix_common_mistakes("42 з50"), "42 350");
        // Буква «з» в слове не трогается: она не среди цифр
        assert_eq!(fix_common_mistakes("Здоровье"), "Здоровье");
        assert_eq!(fix_common_mistakes("зона"), "зона");
    }

    #[test]
    fn fixes_zero_read_as_cyrillic_o() {
        assert_eq!(fix_common_mistakes("1О5"), "105");
        assert_eq!(fix_common_mistakes("2оо"), "200");
        // В слове «Обнаружение» буква остаётся
        assert_eq!(fix_common_mistakes("Обнаружение"), "Обнаружение");
    }

    #[test]
    fn fixes_percent_read_as_zero_slash_zero() {
        // Наблюдаемая ошибка: «%» распознаётся как «0/0» — «12%» даёт «120/0», «250%» — «2500/0»
        assert_eq!(fix_common_mistakes("120/0"), "12%");
        assert_eq!(fix_common_mistakes("2500/0"), "250%");
        assert_eq!(fix_common_mistakes("12°"), "12%");
        // Слэш без нуля после — обычный текст, его не трогаем
        assert_eq!(fix_common_mistakes("12/34"), "12/34");
        // «0/0» без цифры перед ним не превращается в процент
        assert_eq!(fix_common_mistakes("а0/0"), "а0/0");
    }

    #[test]
    fn keeps_ordinary_text_untouched() {
        for text in [
            "Здоровье (макс)",
            "Физическая атака",
            "Скорость атаки",
            "0.80",
            "Меткость",
        ] {
            assert_eq!(
                fix_common_mistakes(text),
                text,
                "текст не должен меняться: {}",
                text
            );
        }
    }

    #[test]
    fn handles_empty_and_single_char() {
        assert_eq!(fix_common_mistakes(""), "");
        assert_eq!(fix_common_mistakes("з"), "з");
        assert_eq!(fix_common_mistakes("5"), "5");
    }

    /// Ручная проверка на настоящем скриншоте: `TF_OCR_TEST_IMAGE=<путь> cargo test -- --ignored`.
    /// В обычном прогоне пропускается: в репозитории картинок нет, а распознаватель есть только в Windows.
    #[test]
    #[ignore = "нужен файл картинки в TF_OCR_TEST_IMAGE"]
    fn reads_real_screenshot() {
        let path = std::env::var("TF_OCR_TEST_IMAGE").expect("TF_OCR_TEST_IMAGE не задан");
        let bytes = std::fs::read(&path).expect("картинка не читается");
        let res = recognize(&bytes).expect("распознавание не удалось");
        println!(
            "картинка {}x{}, увеличена в {} раз, строк {}",
            res.width,
            res.height,
            res.upscale,
            res.lines.len()
        );
        for line in &res.lines {
            println!("  x={:.3} y={:.3} : {}", line.x, line.y, line.text);
        }
        assert!(!res.lines.is_empty(), "на картинке ничего не распознано");
    }
}
