# COPY.md — Hebrew strings for owner review

All agent/prospect-facing strings. Review before deploy #2.

## WhatsApp (Green-API)
| Context | Text |
|---|---|
| OTP | `🔐 קוד הכניסה שלך לפורלי: {code}\nהקוד תקף ל-5 דקות.` |
| Page live | `🎉 דף הנכס שלך באוויר: {page_url}\nתקף ל-30 יום · לעריכה: agent.call4li.com` (sent by n8n builder) |
| New lead | `🔔 ליד חדש מדף הנכס "{title}"!\n👤 {name}\n📞 {phone}\nדברו איתו עכשיו: https://wa.me/{phone}` |
| Expiry reminder | `⏳ דף הנכס "{title}" יפוג בעוד {n} ימים.\nלהארכה בחינם (30 יום נוספים) בלחיצה אחת:\n{link}\n\nלניהול כל הנכסים: agent.call4li.com` |
| Signup welcome | `ברוכים הבאים לפורלי 🦉\n{name}, החשבון של {business} מוכן!\n\nמה עכשיו? נכנסים ל-agent.call4li.com, פותחים נכס ראשון — ותוך דקות יש לו דף נחיתה עם וידאו, גלריה ומידע על השכונה.` |

## Property page (/p/)
- Expired state: `הדף אינו פעיל` / `תוקף הדף הסתיים. לפרטים על הנכס אפשר לפנות ל{agent}.`
- 404: `הדף לא נמצא` / `ייתכן שהקישור שגוי או שהדף הוסר.`
- Form error: `משהו השתבש — נסו שוב או פנו בוואטסאפ`
- WhatsApp prefill: `היי {agent}, ראיתי את הדף של {title} ואשמח לפרטים`
- Footer: `הדף נוצר אוטומטית ע"י Forly 🦉`

## Extend confirmation page
- `✅ הדף הוארך בהצלחה` / `הדף פעיל עד {date}.`
- Invalid link: `הקישור אינו תקף` / `ייתכן שהדף כבר הוארך. ניתן להאריך גם דרך agent.call4li.com`

## Dashboard
Full strings live in public-agent/*.html (login, create, edit, signup, empty
states, toasts). Grep for Hebrew there during review.
