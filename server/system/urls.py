from django.contrib import admin
from django.urls import include, path

from app.api.v1.api import api_v1


urlpatterns = [
    path('api/stripe/', include('app.checkout.urls.webhook_urls', namespace='stripe')),
    path('api/v1/', api_v1.urls),
    path('checkout/', include('app.checkout.urls.page_urls', namespace='checkout')),
    path('django/admin/', admin.site.urls),
]
