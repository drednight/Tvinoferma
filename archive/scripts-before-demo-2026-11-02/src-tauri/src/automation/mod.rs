//! Скрипты автоматизации (промокоды, перевод предметов, покупка за Древние монеты, «Сундук караванщика»).
//! Команды зарегистрированы в `lib.rs`: `activate_promo`, `read_transfer_page`, `transfer_items`,
//! `read_shop`, `read_shop_history`, `buy_shop_item` (покупка за Древние монеты), `open_caravan_chests`.
//! Статус и план: Issues #25 (промокоды), #26 (перевод предметов) в ROADMAP.md.

pub mod caravan;
pub mod promo;
pub mod shop;
pub mod transfer;
