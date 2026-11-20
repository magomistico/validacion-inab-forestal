(ns collect-earth-online.db.users
  (:import java.net.URLEncoder
           java.text.SimpleDateFormat
           java.util.Date
           java.time.format.DateTimeFormatter
           java.time.LocalDateTime
           java.util.UUID)
  (:require [clojure.string             :as str]
            [postal.core                :refer [send-message]]
            [triangulum.database        :refer [call-sql sql-primitive]]
            [triangulum.type-conversion :as tc]
            [triangulum.config          :refer [get-config]]
            [triangulum.email           :refer [email? send-mail get-base-url]]
            [triangulum.logging         :refer [log-str]]
            [triangulum.response        :refer [data-response]]))

(defn- get-login-errors [user]
  (cond (nil? user)
        "Correo electrónico o contraseña incorrectos."

        (not (:verified user))
        "Tu cuenta aún no ha sido verificada."))

(defn login [{:keys [params]}]
  (let [{:keys [email password]} params
        clean-email (str/lower-case (str/trim (or email "")))
        clean-pass  (str password)
        user        (try
                      (first (call-sql "check_login" {:log? false} clean-email clean-pass))
                      (catch Exception _ nil))
        user-info   {:userId        (:user_id user)
                     :userName      clean-email
                     :acceptedTOS   (:accept_tos user)
                     :userRole      (if (:administrator user) "admin" "user")}]
    (if-let [error-msg (get-login-errors user)]
      (data-response error-msg)
      (data-response "" {:session user-info}))))

(defn- get-register-errors [email password password-confirmation]
  (cond (sql-primitive (call-sql "email_taken" email -1))
        (str "La cuenta " email " ya está registrada.")

        (not (email? email))
        (str email " no es una dirección de correo válida.")

        (< (count password) 6)
        "La contraseña debe tener al menos 6 caracteres."

        (not= password password-confirmation)
        "La contraseña y su confirmación no coinciden."

        :else nil))

(defn register [{:keys [params]}]
  (let [reset-key             (str (UUID/randomUUID))
        email                 (str/lower-case (str/trim (or (:email params) "")))
        password              (str (:password params))
        password-confirmation (str (:passwordConfirmation params))]
    (if-let [error-msg (get-register-errors email password password-confirmation)]
      (data-response error-msg)
      (try
        (let [user-id   (sql-primitive (call-sql "add_user" {:log? false} email password reset-key))
              _         (call-sql "user_verified" user-id)
              user-info {:userId      user-id
                         :userName    email
                         :acceptedTOS nil
                         :userRole    "user"}]
          (data-response "" {:session user-info}))
        (catch Exception _
          (data-response "No se pudo registrar la cuenta. Por favor verifica que los datos sean correctos."))))))

(defn logout [_]
  (data-response "" {:session nil}))

(defn- get-update-account-errors [user-id current-email current-password new-email password password-confirmation]
  (cond (str/blank? current-password)
        "Current Password required"

        (empty? (call-sql "check_login" {:log? false} current-email current-password))
        "Invalid current password."

        (not (or (str/blank? new-email) (email? new-email)))
        (str new-email " is not a valid email address.")

        (and (not (str/blank? new-email))
             (sql-primitive (call-sql "email_taken" new-email user-id)))
        (str "An account with the email " new-email " already exists.")

        (and (not (str/blank? password)) (< (count password) 8))
        "New Password must be at least 8 characters."

        (not= password password-confirmation)
        "New Password and Password confirmation do not match."

        :else nil))

(defn update-account [{:keys [params]}]
  (let [user-id               (:userId params -1)
        current-email         (:userName params)
        current-password      (:currentPassword params)
        new-email             (:email params)
        password              (:password params)
        password-confirmation (:passwordConfirmation params)]
    (if-let [error-msg (get-update-account-errors user-id current-email current-password
                                                  new-email password password-confirmation)]
      (data-response error-msg)
      ;; TODO: Create a single "update_user_information" sql function, use user_id instead of email
      (let [updated-email (if (or (str/blank? new-email) (= new-email current-email))
                            current-email
                            (sql-primitive (call-sql "set_user_email" current-email new-email)))]
        (when-not (str/blank? password)
          (call-sql "update_password" {:log? false} updated-email password))
        (data-response "" {:session {:userName updated-email}})))))

(defn- smtp-configured? []
  (let [mail-cfg (get-config :mail)]
    (and (not (str/blank? (:user mail-cfg)))
         (not (str/blank? (:pass mail-cfg))))))

(defn- resolve-base-url [{:keys [headers scheme]}]
  (let [configured (str/replace (str (or (get-base-url) "")) #"/+$" "")
        use-config? (and (not (str/blank? configured))
                         (not (str/includes? configured "my.domain")))]
    (if use-config?
      configured
      (let [proto (or (get headers "x-forwarded-proto")
                      (when scheme (name scheme))
                      "https")
            host  (or (get headers "x-forwarded-host")
                      (get headers "host")
                      "inab-sig.duckdns.org")]
        (str proto "://" host)))))

(defn- build-reset-url [request email reset-key]
  (format "%s/password-reset?email=%s&passwordResetKey=%s"
          (resolve-base-url request)
          (URLEncoder/encode (str email) "UTF-8")
          (URLEncoder/encode (str reset-key) "UTF-8")))

(defn- escape-html [s]
  (-> (str s)
      (str/replace "&" "&amp;")
      (str/replace "<" "&lt;")
      (str/replace ">" "&gt;")
      (str/replace "\"" "&quot;")))

(defn- send-password-reset-email! [email reset-url]
  (let [mail-cfg     (select-keys (get-config :mail) [:host :user :pass :tls :port])
        env-from     (str/trim (or (System/getenv "SMTP_FROM") ""))
        env-name     (str/trim (or (System/getenv "SMTP_FROM_NAME") ""))
        from-addr    (if (str/blank? env-from) (:user mail-cfg) env-from)
        from-name    (if (str/blank? env-name) "INAB SIG" env-name)
        from-domain  (or (second (str/split (str from-addr) #"@" 2)) "inab.gob.gt")
        from-header  (format "%s <%s>" from-name from-addr)
        text-body    (format (str "Hola,\n\n"
                                  "Recibimos una solicitud para restablecer la contraseña de la cuenta %s en INAB SIG.\n\n"
                                  "Abre el siguiente enlace de un solo uso para crear tu nueva contraseña:\n\n"
                                  "%s\n\n"
                                  "Si no solicitaste este cambio, puedes ignorar este correo de forma segura.\n\n"
                                  "Instituto Nacional de Bosques (INAB) - Guatemala\n"
                                  "Plataforma de Validación Forestal INAB SIG")
                             email reset-url)
        safe-email   (escape-html email)
        safe-url     (escape-html reset-url)
        html-body    (format (str "<!DOCTYPE html>"
                                  "<html lang=\"es\"><head><meta charset=\"UTF-8\"></head>"
                                  "<body style=\"margin:0;padding:24px;background-color:#f4f6f4;font-family:Arial,Helvetica,sans-serif;color:#1f2937;\">"
                                  "<table role=\"presentation\" width=\"100%%\" cellspacing=\"0\" cellpadding=\"0\" style=\"max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;border:1px solid #d1e7d5;overflow:hidden;\">"
                                  "<tr><td style=\"background-color:#1b4332;padding:20px 28px;color:#ffffff;\">"
                                  "<h1 style=\"margin:0;font-size:18px;font-weight:700;letter-spacing:0.3px;\">INAB · SIG</h1>"
                                  "<p style=\"margin:4px 0 0 0;font-size:12px;color:#c7ebd0;\">Plataforma de Validación Forestal</p>"
                                  "</td></tr>"
                                  "<tr><td style=\"padding:28px;\">"
                                  "<h2 style=\"margin:0 0 12px 0;font-size:17px;color:#111827;\">Solicitud de restablecimiento de contraseña</h2>"
                                  "<p style=\"margin:0 0 14px 0;font-size:14px;line-height:1.55;\">"
                                  "Recibimos una solicitud para cambiar la contraseña de la cuenta <strong>%s</strong>."
                                  "</p>"
                                  "<p style=\"margin:0 0 22px 0;font-size:14px;line-height:1.55;\">"
                                  "Haz clic en el siguiente botón para definir tu nueva contraseña (enlace de un solo uso):"
                                  "</p>"
                                  "<p style=\"margin:0 0 22px 0;text-align:center;\">"
                                  "<a href=\"%s\" style=\"display:inline-block;background-color:#2d6a4f;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;\">Restablecer contraseña</a>"
                                  "</p>"
                                  "<p style=\"margin:0 0 12px 0;font-size:12px;color:#4b5563;line-height:1.5;\">"
                                  "Si el botón no funciona, copia y pega este enlace en tu navegador:<br>"
                                  "<a href=\"%s\" style=\"color:#2d6a4f;word-break:break-all;\">%s</a>"
                                  "</p>"
                                  "<p style=\"margin:16px 0 0 0;font-size:12px;color:#6b7280;\">"
                                  "Si no solicitaste este cambio, puedes ignorar este mensaje."
                                  "</p>"
                                  "</td></tr>"
                                  "<tr><td style=\"background-color:#f9fafb;padding:14px 28px;border-top:1px solid #e5e7eb;font-size:11px;color:#6b7280;\">"
                                  "Instituto Nacional de Bosques (INAB) · Guatemala"
                                  "</td></tr></table></body></html>")
                             safe-email safe-url safe-url safe-url)
        result       (send-message
                      mail-cfg
                      {:from           from-header
                       :reply-to       from-addr
                       :to             email
                       :subject        "Restablecer contraseña - INAB SIG"
                       :message-id     #(str "<" (UUID/randomUUID) "@" from-domain ">")
                       :user-agent     "INAB-SIG-Mailer/1.0"
                       :Auto-Submitted "auto-generated"
                       :body           [:alternative
                                        {:type    "text/plain; charset=utf-8"
                                         :content text-body}
                                        {:type    "text/html; charset=utf-8"
                                         :content html-body}]})]
    (when-not (= :SUCCESS (:error result))
      (throw (ex-info (str "SMTP error: " (or (:message result) (:error result) result))
                      {:result result})))
    result))

(defn password-request [{:keys [params] :as request}]
  (let [clean-email (str/lower-case (str/trim (or (:email params) "")))
        reset-key   (str (UUID/randomUUID))
        email       (when-not (str/blank? clean-email)
                      (sql-primitive (call-sql "set_password_reset_key" {:log? false} clean-email reset-key)))]
    (cond
      (str/blank? clean-email)
      (data-response "Por favor ingresa tu correo electrónico.")

      (nil? email)
      (data-response "No existe ninguna cuenta registrada con ese correo electrónico.")

      (not (smtp-configured?))
      (data-response
       "El envío automático de correos (SMTP) aún no está configurado en el servidor. Solicita a un administrador de INAB · SIG que te genere un enlace de recuperación desde la pestaña Usuarios.")

      :else
      (let [reset-url (build-reset-url request email reset-key)]
        (try
          (send-password-reset-email! email reset-url)
          (data-response "")
          (catch Exception e
            (println "[WARN] Error enviando correo de recuperación a" email ":" (ex-message e))
            (log-str "[WARN] Error enviando correo de recuperación a " email ": " (ex-message e))
            (data-response
             "No se pudo enviar el correo de recuperación en este momento. Verifica la configuración SMTP o solicita a un administrador un enlace desde la pestaña Usuarios.")))))))

(defn- get-password-reset-errors [user email reset-key password password-confirmation]
  (cond (nil? user)
        "No existe ninguna cuenta registrada con ese correo electrónico."

        (or (str/blank? reset-key)
            (str/blank? (:reset_key user))
            (not= reset-key (:reset_key user)))
        (str "El enlace o código de recuperación para " email " es inválido o ya fue utilizado. Solicita uno nuevo.")

        (< (count (or password "")) 6)
        "La contraseña debe tener al menos 6 caracteres."

        (not= password password-confirmation)
        "La contraseña y su confirmación no coinciden."

        :else nil))

(defn password-reset [{:keys [params]}]
  (let [email                 (str/lower-case (str/trim (or (:email params) "")))
        reset-key             (str/trim (or (:passwordResetKey params) ""))
        password              (str (or (:password params) ""))
        password-confirmation (str (or (:passwordConfirmation params) ""))
        user                  (when-not (str/blank? email)
                                (first (call-sql "get_user_by_email" email)))]
    (if-let [error-msg (get-password-reset-errors user email reset-key password password-confirmation)]
      (data-response error-msg)
      (do
        (call-sql "update_password" {:log? false} email password)
        (data-response "")))))

(defn admin-password-reset-link [{:keys [params session] :as request}]
  (let [institution-id (tc/val->int (:institutionId params))
        clean-email    (str/lower-case (str/trim (or (:email params) "")))
        send-email?    (boolean (:sendEmail params))
        global-admin?  (= "admin" (:userRole session))
        inst-emails    (when (pos? institution-id)
                         (->> (call-sql "get_all_users_by_institution_id" institution-id)
                              (map #(str/lower-case (str/trim (or (:email %) ""))))
                              (set)))
        allowed?       (or global-admin? (contains? inst-emails clean-email))]
    (cond
      (str/blank? clean-email)
      (data-response {:ok false :error "Correo electrónico requerido."} {:status 400})

      (not allowed?)
      (data-response {:ok false :error "El usuario no pertenece a esta institución."} {:status 403})

      :else
      (let [reset-key (str (UUID/randomUUID))
            email     (sql-primitive (call-sql "set_password_reset_key" {:log? false} clean-email reset-key))]
        (if-not email
          (data-response {:ok false :error "No existe ninguna cuenta con ese correo."} {:status 404})
          (let [reset-url  (build-reset-url request email reset-key)
                smtp-ready (smtp-configured?)
                email-sent (if (and send-email? smtp-ready)
                             (try
                               (send-password-reset-email! email reset-url)
                               true
                               (catch Exception e
                                 (log-str "[WARN] Error enviando correo admin reset a " email ": " (ex-message e))
                                 false))
                             false)]
            (data-response {:ok        true
                            :email     email
                            :resetUrl  reset-url
                            :smtpReady smtp-ready
                            :emailSent email-sent})))))))

(defn- get-verify-email-errors [user email reset-key]
  (cond (nil? user)
        "There is no user with that email address."

        (not= reset-key (:reset_key user))
        (str "Invalid reset key for user " email ".")

        :else nil))

(defn verify-email [{:keys [params]}]
  (let [email     (:email params)
        reset-key (:passwordResetKey params)
        user      (first (call-sql "get_user_by_email" email))]
    (if-let [error-msg (get-verify-email-errors user email reset-key)]
      (data-response error-msg)
      (do
        (call-sql "user_verified" (:user_id user))
        (data-response "")))))

(defn get-institution-users [{:keys [params]}]
  (let [institution-id (tc/val->int (:institutionId params))
        all-users      (mapv (fn [{:keys [user_id email institution_role]}]
                               {:id              user_id
                                :email           email
                                :institutionRole institution_role})
                             (call-sql "get_all_users_by_institution_id" institution-id))]
    (data-response all-users)))

(defn get-user-stats [{:keys [params]}]
  (let [account-id (tc/val->int (:accountId params))]    
    (if-let [stats (first (call-sql "get_user_stats" account-id))]
      (data-response {:totalProjects (:total_projects stats)
                      :totalPlots    (:total_plots stats)
                      :averageTime   (:average_time stats)
                      :perProject    (tc/jsonb->clj (:per_project stats))
                      :acceptTOS     (:accept_tos stats)})
      (data-response {}))))

(defn get-user-admin-institutions [{:keys [session]}]
  (let [user-id (:userId session -1)]
    (if (pos? user-id)
      (->> (call-sql "get_user_admin_institutions" user-id)
           (mapv (fn [{:keys [institution_id institution_name]}]
                   {:id   institution_id
                    :name institution_name}))
           (data-response))
      (data-response []))))

(defn- send-role-assignment-emails! [institution-id assignments]
  (when (seq assignments)
    (let [institution-name (:name (first (call-sql "select_institution_by_id" institution-id -1)))
          institution-url  (str (str/replace (str (get-base-url)) #"/+$" "")
                                "/review-institution?institutionId=" institution-id)
          timestamp        (-> (DateTimeFormatter/ofPattern "yyyy/MM/dd HH:mm:ss")
                               (.format (LocalDateTime/now)))]
      (future
        (doseq [{:keys [email role]} assignments]
          (try
            (send-mail email nil nil "User Role Assignment"
                       (format (str "Dear %s,\n\n"
                                    "You have been assigned the role of %s for %s on %s.\n\n"
                                    "To access the institution page, simply click the following link:\n\n"
                                    "%s\n\n"
                                    "Kind Regards,\n"
                                    "  The CEO Team")
                               email role institution-name timestamp institution-url)
                       :text)
            (catch Exception e
              (log-str "Failed to send the role assignment email to " email ": " (ex-message e)))))))))

(defn- assign-institution-role! [institution-id current-roles account-id role]
  (let [email (:email (first (call-sql "get_user_by_id" account-id)))]
    (cond
      (nil? email)
      {:message (str "User with id " account-id " not found.")}

      (= role (get current-roles account-id))
      {:message (str email " already has role " role ".")}

      (or (sql-primitive (call-sql "update_institution_user_role" institution-id account-id role))
          (sql-primitive (call-sql "add_institution_user" institution-id account-id role)))
      {:message  (str email " has been assigned role " role ".")
       :assigned {:email email :role role}}

      :else
      {:message (str "Could not assign role " role " to " email ".")})))

(defn update-institution-role [{:keys [params]}]
  (let [account-ids      (mapv tc/val->int (or (:accountIds params) []))
        institution-id   (tc/val->int (:institutionId params))
        institution-role (:institutionRole params)]
    (cond
      (= institution-role "not-member")
      (data-response
       (mapv (fn [aid]
               (let [email (:email (first (call-sql "get_user_by_id" aid)))]
                 (if (nil? email)
                   (str "User with id " aid " not found.")
                   (do
                     (call-sql "remove_institution_user_role" institution-id aid)
                     (str "User " email " has been removed.")))))
             account-ids))
      (seq account-ids)
      (let [current-roles (into {}
                                (map (juxt :user_id :institution_role))
                                (call-sql "get_all_users_by_institution_id" institution-id))
            results       (mapv #(assign-institution-role! institution-id current-roles % institution-role)
                                account-ids)]
        (send-role-assignment-emails! institution-id (keep :assigned results))
        (data-response (mapv :message results)))

      :else
      (data-response "No accountIds were provided."))))

(defn- process-user [institution-id {:keys [email role] :or {role "member"}}]
  (let [user (first (call-sql "get_user_by_email" email))]
    (cond
      (not user)
      {:email email :reason "User does not exist in CEO"}
      :else
      (try
        (if (sql-primitive (call-sql "add_institution_user" institution-id (:user_id user) role))
          {:email email :role role}
          {:email email :reason "Unknown database error"})
        (catch Exception _
          {:email email :reason "User is already assigned to this institution"})))))

(defn add-user-to-institution [{:keys [params]}]
  (let [{:keys [newUsers institutionId]} params
        institution-id (tc/val->int institutionId)]
    (if (empty? newUsers)
      (data-response [] {:status 200})
      (let [results  (mapv #(process-user institution-id %) newUsers)
            failures (filterv :reason results)]
        (send-role-assignment-emails! institution-id (remove :reason results))
        (data-response failures {:status (if (seq failures) 400 200)})))))

(defn request-institution-membership [{:keys [params session]}]
  (let [user-id        (:userId session -1)
        institution-id (tc/val->int (:institutionId params))]
    (if (pos? user-id)
      (do
        (call-sql "add_institution_user" institution-id user-id 3)
        (let [institution-name (:name (first (call-sql "select_institution_by_id" institution-id -1)))
              timestamp        (-> (DateTimeFormatter/ofPattern "yyyy/MM/dd HH:mm:ss")
                                   (.format (LocalDateTime/now)))
              user-email       (:email (first (call-sql "get_user_by_id" user-id)))
              admin-emails     (->> (call-sql "get_all_users_by_institution_id" institution-id)
                                    (filter (fn [{:keys [institution_role]}] (= institution_role "admin")))
                                    (map :email))
              email-msg       (format (str "User %s has requested the access to institution \"%s\" on %s.\n\n"
                                           "To access the institution page, simply click the following link:\n\n"
                                           "%sreview-institution?institutionId=%s")
                                      user-email
                                      institution-name
                                      timestamp
                                      (get-base-url)
                                      institution-id)]
          (try
            (send-mail admin-emails nil nil "CEO Membership Request" email-msg :text)
            (data-response (str "Membership has been requested for user " user-email "."))
            (catch Exception _
              (data-response (str user-email
                                  " has requested the membership to "
                                  institution-name
                                  ", but the email notification has failed."))))))
      (data-response "You must be logged into request membership."))))

(defn confirm-data-sharing!
  [req]
  (let [{:keys [params session]} req
        user-id          (:userId session)
        project-id       (tc/val->int (:projectId params))
        slug (-> params :interpreterName
                 (str ":user:" user-id ":"
                      (.format (SimpleDateFormat. "YYYYMMddHHmmss") (Date.))))]
    (try
      (if (= -1 user-id)
        (do
          (call-sql "guest_user_data_sharing" slug (or (:remote-addr req) ""))
          (data-response {:message "success"} {:session {:acceptedTOS slug}}))
        (do
          (call-sql "user_data_sharing" project-id user-id slug (or (:remote-addr req) "") slug)
          (data-response {:message "success"} {:session (assoc session :acceptedTOS slug)})))
      (catch Exception e
        (data-response {:message "error when accepting data sharing terms."} {:status 500})))))

(defn check-email-taken [{:keys [params]}]
  (let [email (:email params)]    
    (try (when (sql-primitive (call-sql "get_user_by_email" email))           
           (data-response true))
         (catch Exception e           
           (data-response false)))))

(defn resend-validation-email [{:keys [params]}]
  (let [email          (:email params)
        reset-key      (str (UUID/randomUUID))
        timestamp      (-> (DateTimeFormatter/ofPattern "yyyy/MM/dd HH:mm:ss")
                           (.format (LocalDateTime/now)))
        email-msg      (format (str "Dear %s,\n\n"
                                    "Thank you for signing up for CEO!\n\n"
                                    "Your Account Summary Details:\n\n"
                                    "  Email: %s\n"
                                    "  Created on: %s\n\n"
                                    "  Click the following link to verify your email:\n"
                                    "  %s/verify-email?email=%s&passwordResetKey=%s\n\n"
                                    "Kind Regards,\n"
                                    "  The CEO Team")
                               email email timestamp (get-base-url) (URLEncoder/encode email) reset-key)]
    (try
      (do (send-mail email nil nil "Welcome to CEO!" email-msg :text)
          (data-response (format "Email Sent. Please check all inboxes at %s for a new email with further instructions." email)))
      (catch Exception _
	(data-response  "A server error interrupted your request. Please try again or contact an administrator.")))))

(defn user-accept-tos [{:keys [params session]}]
  (let [user-id (tc/val->int (:userId session))
        slug (-> params :slug
                 (str ":user:" user-id ":"
                      (.format (SimpleDateFormat. "YYYYMMddHHmmss") (Date.))))]
    (try (do
           (call-sql "user_accept_tos" user-id slug)
           (data-response true))
         (catch Exception e
           (data-response {:message "error accepting TOS"} {:status 500})))))
