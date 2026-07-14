/* Forly Nadlan — shared landing-page i18n.
   Chrome (fixed UI labels/buttons) is authored in Hebrew in each template and
   tagged with data-i18n / data-i18n-ph. The page's chosen language arrives on
   the payload (window.__PAGE__.language / the property-page API). Per-listing
   copy (title, price, area blurb, carousel…) is NOT translated here — it is
   generated in the target language upstream and bound by runtime.js / page.js.

   API:
     I18N.apply(root, lang)      → set <html lang/dir>, fill [data-i18n] text and
                                    [data-i18n-ph] placeholders under root.
     I18N.t(lang, key, vars)     → one translated string; {tokens} filled from vars.
     I18N.isRTL(lang)            → true for he/ar. */
(function () {
  "use strict";
  var DICT = {
    "he": {
      "contact_agent": "שיחה עם המתווך", "book_visit": "תיאום ביקור", "book_visit_private": "תיאום ביקור פרטי", "book_visit_property": "תיאום ביקור בנכס",
      "gallery_and_spec": "גלריה ומפרט", "view_gallery": "צפו בגלריה", "see_it_myself": "אני רוצה לראות אותו", "about_area_arrow": "על השכונה ↓",
      "talk_about_property": "דברו איתי על הנכס", "send_details": "שלחו לי פרטים", "direct_whatsapp": "וואטסאפ ישיר", "whatsapp_talk": "דברו איתי בוואטסאפ", "whatsapp": "וואטסאפ",
      "asking_price": "מחיר מבוקש", "monthly_rent": "שכר דירה חודשי", "for_sale": "למכירה", "for_rent": "להשכרה",
      "rooms": "חדרים", "rooms_short": "חד׳", "built_area": "שטח בנוי", "sqm": "מ״ר", "floor": "קומה", "per_month": "/ חודש", "license_label": "רישיון תיווך",
      "why_here": "למה דווקא כאן", "the_property": "הנכס", "peek_inside": "הצצה פנימה", "whats_inside": "מה יש בפנים", "gallery": "גלריה", "moments_from_tour": "רגעים מתוך הסיור",
      "the_address": "הכתובת", "the_area": "השכונה", "video_tour": "סיור וידאו", "tour_video": "סרטון סיור",
      "gallery_hint_click": "לחצו על תמונה להגדלה", "gallery_hint_drag": "↔ גררו לצדדים · לחצו להגדלה", "scroll": "גללו", "or": "או",
      "form_name": "שם מלא", "form_phone": "טלפון נייד", "form_message": "הודעה (אופציונלי)", "ph_name": "ישראל ישראלי", "ph_message": "אשמח לתאם ביקור...",
      "lead_sent": "✓ הפרטים נשלחו — נחזור אליכם בהקדם", "footer_disclaimer": "הדף נוצר אוטומטית ע״י Forly 🦉 · כל הפרטים כפופים לאימות",
      "gallery_head": "כל חדר, מכל זווית.", "gallery_sub": "מה שהסיור לא הספיק להראות — לחצו על תמונה לצפייה במסך מלא.",
      "why_head": "נכס כזה לא מגיע ללוחות. הוא מגיע לאנשים הנכונים.", "why_sub": "כמה סיבות שבגללן הנכס הזה שווה ביקור — ולמה כדאי להגיע לפני כולם.",
      "area_sub": "אחת השכונות המבוקשות באזור — וזה לא במקרה.", "video_sound": "הפעלת קול", "sent_title": "הפרטים אצלנו.",
      "sent_body": "נחזור אליכם באופן אישי בהקדם. בינתיים — שווה לצפות בסיור עוד פעם 😉", "not_found": "הדף לא נמצא", "step_next": "הצעד הבא?",
      "wa_prefill": "שלום, ראיתי את {title} ואשמח לתאם ביקור.", "lead_wa_prefill": "שלום, אני {name} ({phone}) ואשמח לתאם ביקור ב{title}.",
      "expired_contact": "תוקף הדף הסתיים. לפרטים על הנכס אפשר לפנות ל{name}.",
      "trust_personal": "מענה אישי בתוך שעתיים בשעות הפעילות", "trust_scheduled": "ביקור מתואם אישית, בזמן שנוח לכם", "trust_private": "הפרטים שלכם נשארים אצלנו בלבד",
      "parking": "חניות", "registered": "בטאבו", "form_error": "משהו השתבש — נסו שוב או פנו בוואטסאפ", "here_area": "השכונה"
    },
    "en": {
      "contact_agent": "Speak with the agent", "book_visit": "Book a visit", "book_visit_private": "Book a private visit", "book_visit_property": "Book a viewing",
      "gallery_and_spec": "Gallery & specs", "view_gallery": "View gallery", "see_it_myself": "I want to see it", "about_area_arrow": "About the area ↓",
      "talk_about_property": "Talk to me about the property", "send_details": "Send me details", "direct_whatsapp": "WhatsApp direct", "whatsapp_talk": "Chat with me on WhatsApp", "whatsapp": "WhatsApp",
      "asking_price": "Asking price", "monthly_rent": "Monthly rent", "for_sale": "For sale", "for_rent": "For rent",
      "rooms": "Rooms", "rooms_short": "rm", "built_area": "Built area", "sqm": "sqm", "floor": "Floor", "per_month": "/ month", "license_label": "Broker license",
      "why_here": "Why here", "the_property": "The property", "peek_inside": "A peek inside", "whats_inside": "What's inside", "gallery": "Gallery", "moments_from_tour": "Moments from the tour",
      "the_address": "The address", "the_area": "The area", "video_tour": "Video tour", "tour_video": "Tour video",
      "gallery_hint_click": "Tap a photo to enlarge", "gallery_hint_drag": "↔ Drag sideways · tap to enlarge", "scroll": "Scroll", "or": "or",
      "form_name": "Full name", "form_phone": "Mobile phone", "form_message": "Message (optional)", "ph_name": "John Smith", "ph_message": "I'd love to book a visit...",
      "lead_sent": "✓ Details sent — we'll get back to you shortly", "footer_disclaimer": "This page was generated automatically by Forly 🦉 · All details subject to verification",
      "gallery_head": "Every room, from every angle.", "gallery_sub": "What the tour didn't have time to show — tap a photo to view full screen.",
      "why_head": "A property like this never hits the listings. It reaches the right people.", "why_sub": "A few reasons this property is worth a visit — and why you'll want to get there before everyone else.",
      "area_sub": "One of the most sought-after neighborhoods in the area — and that's no accident.", "video_sound": "Turn on sound", "sent_title": "We've got your details.",
      "sent_body": "We'll get back to you personally very soon. In the meantime — the tour is worth another look 😉", "not_found": "Page not found", "step_next": "The next step?",
      "wa_prefill": "Hi, I saw {title} and I'd love to book a visit.", "lead_wa_prefill": "Hi, I'm {name} ({phone}) and I'd love to book a visit to {title}.",
      "expired_contact": "This page has expired. For details about the property, please contact {name}.",
      "trust_personal": "Personal reply within two hours during business hours", "trust_scheduled": "A visit arranged personally, at a time that suits you", "trust_private": "Your details stay with us alone",
      "parking": "parking", "registered": "registered", "form_error": "Something went wrong — try again or reach out on WhatsApp", "here_area": "The area"
    },
    "ar": {
      "contact_agent": "التحدث مع الوسيط", "book_visit": "تحديد موعد زيارة", "book_visit_private": "تحديد موعد زيارة خاصة", "book_visit_property": "تحديد موعد معاينة العقار",
      "gallery_and_spec": "المعرض والمواصفات", "view_gallery": "استعرض المعرض", "see_it_myself": "أريد أن أراه بنفسي", "about_area_arrow": "عن الحي ↓",
      "talk_about_property": "تحدث معي عن العقار", "send_details": "أرسل لي التفاصيل", "direct_whatsapp": "واتساب مباشر", "whatsapp_talk": "تحدث معي عبر واتساب", "whatsapp": "واتساب",
      "asking_price": "السعر المطلوب", "monthly_rent": "الإيجار الشهري", "for_sale": "للبيع", "for_rent": "للإيجار",
      "rooms": "غرف", "rooms_short": "غرفة", "built_area": "المساحة المبنية", "sqm": "م²", "floor": "الطابق", "per_month": "/ شهر", "license_label": "ترخيص وساطة",
      "why_here": "لماذا هنا تحديدًا", "the_property": "العقار", "peek_inside": "إطلالة من الداخل", "whats_inside": "ما الذي بالداخل", "gallery": "المعرض", "moments_from_tour": "لحظات من الجولة",
      "the_address": "العنوان", "the_area": "الحي", "video_tour": "جولة بالفيديو", "tour_video": "فيديو الجولة",
      "gallery_hint_click": "اضغط على الصورة لتكبيرها", "gallery_hint_drag": "↔ اسحب إلى الجانبين · اضغط للتكبير", "scroll": "مرّر", "or": "أو",
      "form_name": "الاسم الكامل", "form_phone": "الهاتف المحمول", "form_message": "رسالة (اختياري)", "ph_name": "محمد أحمد", "ph_message": "يسعدني تحديد موعد زيارة...",
      "lead_sent": "✓ تم إرسال التفاصيل — سنعاود التواصل معك قريبًا", "footer_disclaimer": "تم إنشاء هذه الصفحة تلقائيًا بواسطة Forly 🦉 · جميع التفاصيل خاضعة للتحقق",
      "gallery_head": "كل غرفة، من كل زاوية.", "gallery_sub": "ما لم تُتِح الجولة عرضه — اضغط على الصورة لمشاهدتها بملء الشاشة.",
      "why_head": "عقار كهذا لا يصل إلى الإعلانات. بل يصل إلى الأشخاص المناسبين.", "why_sub": "بعض الأسباب التي تجعل هذا العقار يستحق الزيارة — ولماذا يجدر بك الوصول قبل الجميع.",
      "area_sub": "أحد أكثر الأحياء طلبًا في المنطقة — وهذا ليس من قبيل الصدفة.", "video_sound": "تشغيل الصوت", "sent_title": "تفاصيلك وصلتنا.",
      "sent_body": "سنعاود التواصل معك شخصيًا قريبًا جدًا. في هذه الأثناء — تستحق الجولة مشاهدة أخرى 😉", "not_found": "الصفحة غير موجودة", "step_next": "الخطوة التالية؟",
      "wa_prefill": "مرحبًا، رأيت {title} ويسعدني تحديد موعد زيارة.", "lead_wa_prefill": "مرحبًا، أنا {name} ({phone}) ويسعدني تحديد موعد زيارة لـ{title}.",
      "expired_contact": "انتهت صلاحية هذه الصفحة. للحصول على تفاصيل العقار يمكنك التواصل مع {name}.",
      "trust_personal": "رد شخصي خلال ساعتين ضمن ساعات العمل", "trust_scheduled": "زيارة مرتّبة شخصيًا، في الوقت المناسب لك", "trust_private": "تبقى تفاصيلك لدينا وحدنا",
      "parking": "مواقف", "registered": "مسجّلة", "form_error": "حدث خطأ ما — حاول مرة أخرى أو تواصل عبر واتساب", "here_area": "الحي"
    },
    "ru": {
      "contact_agent": "Связаться с агентом", "book_visit": "Записаться на просмотр", "book_visit_private": "Записаться на частный просмотр", "book_visit_property": "Записаться на осмотр объекта",
      "gallery_and_spec": "Галерея и характеристики", "view_gallery": "Смотреть галерею", "see_it_myself": "Хочу увидеть лично", "about_area_arrow": "О районе ↓",
      "talk_about_property": "Обсудить объект со мной", "send_details": "Пришлите мне детали", "direct_whatsapp": "WhatsApp напрямую", "whatsapp_talk": "Напишите мне в WhatsApp", "whatsapp": "WhatsApp",
      "asking_price": "Запрашиваемая цена", "monthly_rent": "Аренда в месяц", "for_sale": "Продажа", "for_rent": "Аренда",
      "rooms": "Комнаты", "rooms_short": "комн.", "built_area": "Жилая площадь", "sqm": "м²", "floor": "Этаж", "per_month": "/ месяц", "license_label": "Лицензия риелтора",
      "why_here": "Почему именно здесь", "the_property": "Объект", "peek_inside": "Взгляд внутрь", "whats_inside": "Что внутри", "gallery": "Галерея", "moments_from_tour": "Моменты из тура",
      "the_address": "Адрес", "the_area": "Район", "video_tour": "Видеотур", "tour_video": "Видео тура",
      "gallery_hint_click": "Нажмите на фото, чтобы увеличить", "gallery_hint_drag": "↔ Проведите в стороны · нажмите, чтобы увеличить", "scroll": "Листайте", "or": "или",
      "form_name": "Полное имя", "form_phone": "Мобильный телефон", "form_message": "Сообщение (необязательно)", "ph_name": "Иван Иванов", "ph_message": "С удовольствием запишусь на просмотр...",
      "lead_sent": "✓ Детали отправлены — мы свяжемся с вами в ближайшее время", "footer_disclaimer": "Эта страница создана автоматически с помощью Forly 🦉 · Все данные подлежат проверке",
      "gallery_head": "Каждая комната, с каждого ракурса.", "gallery_sub": "То, что тур не успел показать — нажмите на фото, чтобы открыть на весь экран.",
      "why_head": "Такой объект не попадает на доски объявлений. Он попадает к нужным людям.", "why_sub": "Несколько причин, почему этот объект стоит посетить — и почему стоит успеть раньше всех.",
      "area_sub": "Один из самых востребованных районов в округе — и это неслучайно.", "video_sound": "Включить звук", "sent_title": "Ваши данные у нас.",
      "sent_body": "Мы свяжемся с вами лично в самое ближайшее время. А пока — тур стоит пересмотреть ещё раз 😉", "not_found": "Страница не найдена", "step_next": "Следующий шаг?",
      "wa_prefill": "Здравствуйте, я видел {title} и хотел бы записаться на просмотр.", "lead_wa_prefill": "Здравствуйте, меня зовут {name} ({phone}), хотел бы записаться на просмотр {title}.",
      "expired_contact": "Срок действия страницы истёк. За информацией об объекте обращайтесь к {name}.",
      "trust_personal": "Личный ответ в течение двух часов в рабочее время", "trust_scheduled": "Просмотр, организованный лично, в удобное для вас время", "trust_private": "Ваши данные остаются только у нас",
      "parking": "парковка", "registered": "в реестре", "form_error": "Что-то пошло не так — попробуйте ещё раз или напишите в WhatsApp", "here_area": "Район"
    },
    "es": {
      "contact_agent": "Hablar con el agente", "book_visit": "Agendar una visita", "book_visit_private": "Agendar una visita privada", "book_visit_property": "Agendar una visita al inmueble",
      "gallery_and_spec": "Galería y detalles", "view_gallery": "Ver galería", "see_it_myself": "Quiero verlo", "about_area_arrow": "Sobre la zona ↓",
      "talk_about_property": "Háblame del inmueble", "send_details": "Envíame los detalles", "direct_whatsapp": "WhatsApp directo", "whatsapp_talk": "Escríbeme por WhatsApp", "whatsapp": "WhatsApp",
      "asking_price": "Precio de venta", "monthly_rent": "Alquiler mensual", "for_sale": "En venta", "for_rent": "En alquiler",
      "rooms": "Habitaciones", "rooms_short": "hab.", "built_area": "Superficie construida", "sqm": "m²", "floor": "Planta", "per_month": "/ mes", "license_label": "Licencia inmobiliaria",
      "why_here": "Por qué aquí", "the_property": "El inmueble", "peek_inside": "Un vistazo dentro", "whats_inside": "Lo que hay dentro", "gallery": "Galería", "moments_from_tour": "Momentos del recorrido",
      "the_address": "La dirección", "the_area": "La zona", "video_tour": "Recorrido en vídeo", "tour_video": "Vídeo del recorrido",
      "gallery_hint_click": "Toca una foto para ampliar", "gallery_hint_drag": "↔ Desliza a los lados · toca para ampliar", "scroll": "Desliza", "or": "o",
      "form_name": "Nombre completo", "form_phone": "Teléfono móvil", "form_message": "Mensaje (opcional)", "ph_name": "Juan Pérez", "ph_message": "Me encantaría agendar una visita...",
      "lead_sent": "✓ Datos enviados — te responderemos en breve", "footer_disclaimer": "Esta página se generó automáticamente con Forly 🦉 · Todos los datos están sujetos a verificación",
      "gallery_head": "Cada habitación, desde cada ángulo.", "gallery_sub": "Lo que el recorrido no llegó a mostrar — toca una foto para verla a pantalla completa.",
      "why_head": "Un inmueble así no llega a los portales. Llega a las personas adecuadas.", "why_sub": "Algunas razones por las que este inmueble merece una visita — y por qué conviene llegar antes que nadie.",
      "area_sub": "Una de las zonas más solicitadas del área — y no es casualidad.", "video_sound": "Activar sonido", "sent_title": "Ya tenemos tus datos.",
      "sent_body": "Te responderemos personalmente muy pronto. Mientras tanto — el recorrido merece otra mirada 😉", "not_found": "Página no encontrada", "step_next": "¿El siguiente paso?",
      "wa_prefill": "Hola, vi {title} y me encantaría agendar una visita.", "lead_wa_prefill": "Hola, soy {name} ({phone}) y me encantaría agendar una visita a {title}.",
      "expired_contact": "Esta página ha caducado. Para más información sobre el inmueble, puedes contactar con {name}.",
      "trust_personal": "Respuesta personal en menos de dos horas en horario laboral", "trust_scheduled": "Una visita organizada personalmente, a la hora que te convenga", "trust_private": "Tus datos se quedan solo con nosotros",
      "parking": "plazas de garaje", "registered": "registradas", "form_error": "Algo salió mal — inténtalo de nuevo o escríbenos por WhatsApp", "here_area": "La zona"
    },
    "fr": {
      "contact_agent": "Parler à l'agent", "book_visit": "Planifier une visite", "book_visit_private": "Planifier une visite privée", "book_visit_property": "Planifier une visite du bien",
      "gallery_and_spec": "Galerie et détails", "view_gallery": "Voir la galerie", "see_it_myself": "Je veux le voir", "about_area_arrow": "À propos du quartier ↓",
      "talk_about_property": "Parlez-moi du bien", "send_details": "Envoyez-moi les détails", "direct_whatsapp": "WhatsApp direct", "whatsapp_talk": "Écrivez-moi sur WhatsApp", "whatsapp": "WhatsApp",
      "asking_price": "Prix demandé", "monthly_rent": "Loyer mensuel", "for_sale": "À vendre", "for_rent": "À louer",
      "rooms": "Pièces", "rooms_short": "pce", "built_area": "Surface construite", "sqm": "m²", "floor": "Étage", "per_month": "/ mois", "license_label": "Carte professionnelle",
      "why_here": "Pourquoi ici", "the_property": "Le bien", "peek_inside": "Un aperçu de l'intérieur", "whats_inside": "Ce qu'il y a à l'intérieur", "gallery": "Galerie", "moments_from_tour": "Instants de la visite",
      "the_address": "L'adresse", "the_area": "Le quartier", "video_tour": "Visite en vidéo", "tour_video": "Vidéo de la visite",
      "gallery_hint_click": "Touchez une photo pour l'agrandir", "gallery_hint_drag": "↔ Glissez sur les côtés · touchez pour agrandir", "scroll": "Faites défiler", "or": "ou",
      "form_name": "Nom complet", "form_phone": "Téléphone portable", "form_message": "Message (facultatif)", "ph_name": "Jean Dupont", "ph_message": "Je serais ravi de planifier une visite...",
      "lead_sent": "✓ Détails envoyés — nous vous recontactons très vite", "footer_disclaimer": "Cette page a été générée automatiquement par Forly 🦉 · Toutes les informations sont sujettes à vérification",
      "gallery_head": "Chaque pièce, sous tous les angles.", "gallery_sub": "Ce que la visite n'a pas eu le temps de montrer — touchez une photo pour la voir en plein écran.",
      "why_head": "Un bien pareil n'arrive pas sur les annonces. Il arrive aux bonnes personnes.", "why_sub": "Quelques raisons pour lesquelles ce bien mérite une visite — et pourquoi mieux vaut arriver avant tout le monde.",
      "area_sub": "L'un des quartiers les plus prisés du secteur — et ce n'est pas un hasard.", "video_sound": "Activer le son", "sent_title": "Nous avons vos coordonnées.",
      "sent_body": "Nous vous recontacterons personnellement très bientôt. En attendant — la visite mérite un second regard 😉", "not_found": "Page introuvable", "step_next": "La prochaine étape ?",
      "wa_prefill": "Bonjour, j'ai vu {title} et je serais ravi de planifier une visite.", "lead_wa_prefill": "Bonjour, je suis {name} ({phone}) et je serais ravi de planifier une visite de {title}.",
      "expired_contact": "Cette page a expiré. Pour des informations sur le bien, vous pouvez contacter {name}.",
      "trust_personal": "Réponse personnelle sous deux heures pendant les heures d'ouverture", "trust_scheduled": "Une visite organisée personnellement, à l'heure qui vous convient", "trust_private": "Vos coordonnées restent chez nous uniquement",
      "parking": "places de parking", "registered": "enregistrées", "form_error": "Une erreur s'est produite — réessayez ou contactez-nous sur WhatsApp", "here_area": "Le quartier"
    }
  };
  var RTL = { he: 1, ar: 1 };

  function t(lang, key, vars) {
    var d = DICT[lang] || DICT.he;
    var s = (d && d[key] != null) ? d[key] : (DICT.he[key] != null ? DICT.he[key] : key);
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; });
    return s;
  }
  function each(root, sel, fn) { Array.prototype.forEach.call((root || document).querySelectorAll(sel), fn); }

  function apply(root, lang) {
    lang = DICT[lang] ? lang : "he";
    var de = document.documentElement;
    de.setAttribute("lang", lang);
    de.setAttribute("dir", RTL[lang] ? "rtl" : "ltr");
    each(root, "[data-i18n]", function (el) { el.textContent = t(lang, el.getAttribute("data-i18n")); });
    each(root, "[data-i18n-ph]", function (el) { el.setAttribute("placeholder", t(lang, el.getAttribute("data-i18n-ph"))); });
    each(root, "[data-i18n-aria]", function (el) { el.setAttribute("aria-label", t(lang, el.getAttribute("data-i18n-aria"))); });
  }

  window.I18N = { t: t, apply: apply, isRTL: function (l) { return !!RTL[l]; }, langs: Object.keys(DICT) };
})();
