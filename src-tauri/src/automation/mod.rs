//! Скрипты автоматизации (промокоды, перевод предметов, покупка за Древние монеты).
//! Команды зарегистрированы в `lib.rs`: `activate_promo`, `read_transfer_page`, `transfer_items`,
//! `read_shop`, `read_shop_history`, `buy_shop_item` (покупка за Древние монеты).
//! Статус и план: Issues #25 (промокоды), #26 (перевод предметов) в ROADMAP.md.

pub mod promo;
pub mod shop;
pub mod transfer;
