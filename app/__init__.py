import os

from flask import Flask

from config import Config
from .models import db, Settings
from .timeutil import to_pacific


def create_app():
    app = Flask(__name__)
    app.config.from_object(Config)

    os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
    os.makedirs(app.config["INSTANCE_DIR"], exist_ok=True)

    app.jinja_env.filters["to_pt"] = to_pacific

    db.init_app(app)

    with app.app_context():
        db.create_all()
        if Settings.query.first() is None:
            db.session.add(Settings())
            db.session.commit()

    from .routes import bp
    app.register_blueprint(bp)

    return app
