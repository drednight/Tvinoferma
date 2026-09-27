from PIL import Image, ImageDraw
import os

def clean_and_upscale(input_path, output_name, scale=4):
    if not os.path.exists(input_path):
        print(f"❌ Файл {input_path} не найден!")
        return
        
    img = Image.open(input_path).convert("RGBA")
    w, h = img.size
    
    # 1. УДАЛЕНИЕ ЦИФР
    # Мы берем цвет пикселя чуть выше цифр, чтобы замазка была незаметной
    draw = ImageDraw.Draw(img)
    
    # Область цифр: левый нижний угол
    # Настройка координат под ваши скриншоты (примерно 35% ширины и 25% высоты снизу)
    x1, y1 = 0, int(h * 0.72)
    x2, y2 = int(w * 0.40), h
    
    # Берем "чистый" цвет фона из точки чуть выше цифр
    sample_y = int(h * 0.65) 
    bg_color = img.getpixel((int(w * 0.1), sample_y))
    
    # Рисуем прямоугольник поверх цифр
    draw.rectangle([x1, y1, x2, y2], fill=bg_color)

    # 2. АПСКЕЙЛ (Метод NEAREST сохраняет пиксель-арт четким)
    new_size = (w * scale, h * scale)
    result = img.resize(new_size, Image.NEAREST)
    
    result.save(output_name)
    print(f"✅ Готово: {output_name} ({new_size[0]}x{new_size[1]})")

# --- ЗАПУСК ---
# Переименуйте ваши файлы в weapon.png, relics.png, armor.png 
# или поменяйте названия здесь:
process_list = [
    ("weapon.png", "icon_weapon_clean.png"),   # Красное (83)
    ("relics.png", "icon_relics_clean.png"),    # Синее (195)
    ("armor.png",  "icon_armor_clean.png")      # Зеленое (115)
]

for inp, out in process_list:
    clean_and_upscale(inp, out, scale=4)